import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../lib/storage";
import { chat, isOpenCodeGo, listModels } from "../lib/llm";
import { listEmbeddingModels, testEmbeddings } from "../lib/embeddings";
import { applyShortcuts, formatShortcut } from "../lib/shortcuts";
import type { ChatProviderKind, EmbeddingProviderKind, Settings } from "../lib/types";

type PathElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  keys.slice(0, -1).forEach((key) => {
    if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  });
  current[keys[keys.length - 1]] = value;
}

function parseDescriptions(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const description = trimmed.slice(eq + 1).trim();
    if (key) out[key] = description;
  }
  return out;
}

function descriptionsToText(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, description]) => `${key} = ${description}`)
    .join("\n");
}

function readElement(el: PathElement): unknown {
  const type = el.dataset.type;
  if (type === "boolean") return (el as HTMLInputElement).checked;
  if (type === "number") return Number(el.value);
  if (type === "lines") return el.value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (type === "descriptions") return parseDescriptions(el.value);
  return el.value;
}

function writeElement(el: PathElement, value: unknown): void {
  const type = el.dataset.type;
  if (type === "boolean") {
    (el as HTMLInputElement).checked = Boolean(value);
  } else if (type === "lines") {
    el.value = Array.isArray(value) ? value.join("\n") : "";
  } else if (type === "descriptions") {
    el.value = value && typeof value === "object" ? descriptionsToText(value as Record<string, string>) : "";
  } else {
    el.value = value === undefined || value === null ? "" : String(value);
  }
}

let settings: Settings;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function status(message: string, isError = false): void {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function applyValues(): void {
  document.querySelectorAll<PathElement>("[data-path]").forEach((el) => {
    writeElement(el, getPath(settings, el.dataset.path as string));
  });
}

function attachListeners(): void {
  document.querySelectorAll<PathElement>("[data-path]").forEach((el) => {
    const handler = () => {
      const path = el.dataset.path as string;
      setPath(settings as unknown as Record<string, unknown>, path, readElement(el));
      updateProviderHighlight();
      scheduleSave();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(settings);
    status("Saved");
  }, 250);
}

function updateProviderHighlight(): void {
  (["opencode-go", "ollama", "vllm"] as ChatProviderKind[]).forEach((kind) => {
    document.getElementById(`provider-${kind}`)?.classList.toggle("active", settings.activeProvider === kind);
  });
}

function setResult(id: string, text: string, isError = false): void {
  const el = document.getElementById(`result-${id}`);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#f2a1a1" : "#a7ecb0";
}

async function loadDecks(): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({ type: "GET_DECKS" })) as {
      ok: boolean;
      decks?: string[];
    };
    const datalist = document.getElementById("deck-list");
    if (datalist && response?.decks) {
      datalist.innerHTML = response.decks
        .map((deck) => `<option value="${escapeHtml(deck)}"></option>`)
        .join("");
    }
  } catch {
    // ignore
  }
}

const EMBEDDING_MODEL_RE = /(embed|bge|e5|gte|nomic|mxbai|instructor|voyage|jina|granite-embedding|text-embedding)/i;

function isEmbeddingModel(name: string): boolean {
  return EMBEDDING_MODEL_RE.test(name);
}

/** Fill a model <select> from the server list, always preserving the saved value. */
function populateModelSelect(
  target: string,
  models: string[],
  options: { emphasizeEmbedding?: boolean } = {},
): void {
  const select = document.querySelector<HTMLSelectElement>(`select[data-models-for="${target}"]`);
  if (!select) return;
  const saved = String(getPath(settings, select.dataset.path as string) ?? "");
  const list = [...new Set([saved, ...models].filter(Boolean))];
  list.sort((a, b) => {
    if (options.emphasizeEmbedding) {
      const rank = (m: string) => (isEmbeddingModel(m) ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
    }
    return a.localeCompare(b);
  });
  const placeholder = models.length === 0 ? "— no models loaded —" : "— select model —";
  const label = (m: string) =>
    options.emphasizeEmbedding && isEmbeddingModel(m) ? `${m}  (embedding)` : m;
  select.innerHTML =
    `<option value="">${placeholder}</option>` +
    list.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(label(m))}</option>`).join("");

  // If the saved model is not served, fall back to the first embedding-looking
  // model so the user lands on a usable choice instead of a 404.
  let selected = saved;
  if (!list.includes(saved)) {
    selected = options.emphasizeEmbedding ? models.find(isEmbeddingModel) ?? "" : "";
  }
  select.value = list.includes(selected) ? selected : "";
  if (options.emphasizeEmbedding && selected && selected !== saved) {
    setPath(settings as unknown as Record<string, unknown>, select.dataset.path as string, selected);
    scheduleSave();
  }
}

async function loadModelsFor(kind: ChatProviderKind): Promise<void> {
  const config = settings.providers[kind];
  if (isOpenCodeGo(config.baseUrl) && !config.apiKey) {
    populateModelSelect(kind, []);
    setResult(kind, "Enter your API key to load the model list.");
    return;
  }
  setResult(kind, "Loading models…");
  const result = await listModels(config);
  if (!result.ok) {
    populateModelSelect(kind, []);
    setResult(kind, result.error ?? "Could not load models", true);
    return;
  }
  populateModelSelect(kind, result.models);
  const saved = config.model;
  setResult(kind, `Loaded ${result.models.length} models${saved ? ` · selected: ${saved}` : ""}`);
}

async function testChat(kind: ChatProviderKind): Promise<void> {
  setResult(kind, "Testing…");
  const providerSettings = { ...settings, activeProvider: kind };
  try {
    const reply = await chat(
      providerSettings,
      [{ role: "user", content: "Reply with the single word: ok" }],
      { temperature: 0, maxTokens: 200, timeoutMs: 30_000, reasoningEffort: "none" },
    );
    setResult(kind, `OK — reply: "${reply.trim().slice(0, 40)}"`);
  } catch (error) {
    setResult(kind, error instanceof Error ? error.message : String(error), true);
  }
}

async function testEmbeddingsAction(): Promise<void> {
  setResult("embeddings", "Testing…");
  const result = await testEmbeddings(settings.embeddings);
  setResult("embeddings", result.ok ? `OK — ${result.models[0]}` : result.error ?? "Failed", !result.ok);
}

async function detectEmbeddingModels(): Promise<void> {
  setResult("embeddings", "Loading models…");
  if (settings.embeddings.kind !== "ollama" && !settings.embeddings.baseUrl) {
    populateModelSelect("embeddings", [], { emphasizeEmbedding: true });
    setResult("embeddings", "Set the embedding base URL first.", true);
    return;
  }
  const result = await listEmbeddingModels(settings.embeddings);
  if (!result.ok) {
    populateModelSelect("embeddings", [], { emphasizeEmbedding: true });
    setResult("embeddings", result.error ?? "Could not load models", true);
    return;
  }
  populateModelSelect("embeddings", result.models, { emphasizeEmbedding: true });
  const embeddingCount = result.models.filter(isEmbeddingModel).length;
  const note = embeddingCount > 0 ? ` (${embeddingCount} look like embedding models)` : " (none look like embedding models)";
  setResult("embeddings", `Loaded ${result.models.length} models${note}`);
}

let recordingTarget: "capture" | "edit" | "markers" | "autogen" | null = null;

function friendlyName(name: string): string {
  if (name === "capture-cloze") return "Create card";
  if (name === "toggle-markers") return "Toggle markers";
  if (name === "autogen-page") return "Autogen";
  return "Toggle edit";
}

async function applyAndReportShortcuts(): Promise<void> {
  const results = await applyShortcuts(settings.shortcuts);
  const errors = results.filter((r) => !r.ok);
  if (errors.length === 0) {
    setResult("shortcuts", `Active · create = ${settings.shortcuts.capture}, edit = ${settings.shortcuts.edit}`);
  } else {
    setResult("shortcuts", errors.map((e) => `${friendlyName(e.name)}: ${e.error}`).join(" | "), true);
  }
}

function startRecording(target: "capture" | "edit" | "markers" | "autogen"): void {
  recordingTarget = target;
  document.getElementById(`shortcut-${target}`)?.classList.add("recording");
  setResult("shortcuts", `Recording ${target} — press a combination…`);
}

function resetShortcut(target: "capture" | "edit" | "markers" | "autogen"): void {
  const key = target === "markers" ? "toggleMarkers" : target;
  setPath(settings as unknown as Record<string, unknown>, `shortcuts.${key}`, DEFAULT_SETTINGS.shortcuts[key]);
  applyValues();
  void saveSettings(settings).then(applyAndReportShortcuts);
}

function onShortcutKeydown(event: KeyboardEvent): void {
  if (!recordingTarget) return;
  event.preventDefault();
  event.stopPropagation();
  const combo = formatShortcut(event);
  if (!combo) {
    setResult("shortcuts", "Include Ctrl, Alt, or Shift (or use a function key like F8).", true);
    return;
  }
  const target = recordingTarget;
  recordingTarget = null;
  document.getElementById(`shortcut-${target}`)?.classList.remove("recording");
  const key = target === "markers" ? "toggleMarkers" : target;
  setPath(settings as unknown as Record<string, unknown>, `shortcuts.${key}`, combo);
  applyValues();
  void saveSettings(settings).then(applyAndReportShortcuts);
}

async function handleAction(action: string, el: HTMLElement): Promise<void> {
  switch (action) {
    case "test-chat": {
      const kind = el.dataset.provider as ChatProviderKind;
      await testChat(kind);
      break;
    }
    case "detect-chat": {
      const kind = el.dataset.provider as ChatProviderKind;
      await loadModelsFor(kind);
      break;
    }
    case "test-embeddings":
      await testEmbeddingsAction();
      break;
    case "record-shortcut":
      startRecording(el.dataset.target as "capture" | "edit" | "markers" | "autogen");
      break;
    case "reset-shortcut":
      resetShortcut(el.dataset.target as "capture" | "edit" | "markers" | "autogen");
      break;
    case "detect-embeddings":
      await detectEmbeddingModels();
      break;
    case "test-hypothesis": {
      setResult("hypothesis", "Testing…");
      const response = (await browser.runtime.sendMessage({ type: "HYPOTHESIS_TEST" })) as {
        ok: boolean;
        userid?: string;
        error?: string;
      };
      setResult(
        "hypothesis",
        response.ok ? `Connected as ${response.userid ?? "user"}` : response.error ?? "Failed",
        !response.ok,
      );
      break;
    }
    case "clear-hypothesis": {
      await browser.runtime.sendMessage({ type: "HYPOTHESIS_CLEAR" });
      setResult("hypothesis", "Processed-highlight history cleared");
      break;
    }
    case "rebuild-index": {
      setResult("embeddings", "Rebuilding deck index…");
      await saveSettings(settings);
      const response = (await browser.runtime.sendMessage({ type: "REBUILD_INDEX" })) as {
        ok: boolean;
        count?: number;
        error?: string;
      };
      setResult("embeddings", response.ok ? `Indexed ${response.count} decks` : response.error ?? "Failed", !response.ok);
      break;
    }
    case "flush-queue": {
      const response = (await browser.runtime.sendMessage({ type: "FLUSH_QUEUE" })) as {
        ok: boolean;
        flushed?: number;
        remaining?: number;
        added?: number;
        online?: boolean;
        error?: string;
      };
      setResult(
        "anki",
        response.online === false
          ? response.error ?? "Anki is offline"
          : `Flushed ${response.flushed ?? 0} batch(es), added ${response.added ?? 0} cards, ${response.remaining ?? 0} remaining`,
        response.online === false,
      );
      break;
    }
    case "clear-queue": {
      await browser.runtime.sendMessage({ type: "CLEAR_QUEUE" });
      setResult("anki", "Queue cleared");
      break;
    }
    case "open-anki": {
      setResult("anki", "Checking…");
      const response = (await browser.runtime.sendMessage({ type: "PING" })) as {
        ok: boolean;
        anki: boolean;
        provider: string;
        model: string;
      };
      setResult(
        "anki",
        response.anki
          ? `AnkiConnect reachable. Active: ${response.provider} / ${response.model || "(no model)"}`
          : "AnkiConnect unreachable — is Anki running?",
        !response.anki,
      );
      break;
    }
    default:
      break;
  }
}

async function autoLoadModels(): Promise<void> {
  await loadModelsFor(settings.activeProvider);
  if (settings.embeddings.baseUrl) {
    await detectEmbeddingModels();
  }
}

const DEFAULT_EMBEDDING_URLS: Record<EmbeddingProviderKind, string> = {
  ollama: "http://127.0.0.1:11434",
  vllm: "http://127.0.0.1:8000/v1",
  custom: "",
};

function attachModelLoaders(): void {
  document.querySelectorAll<HTMLElement>("[data-loads-models]").forEach((el) => {
    const target = el.dataset.loadsModels as string;
    el.addEventListener("change", () => {
      if (target === "embeddings") {
        // When the embedding provider changes, move the URL to that provider's
        // default if it was still pointing at another provider's default.
        if (el.dataset.path === "embeddings.kind") {
          const kind = (el as HTMLSelectElement).value as EmbeddingProviderKind;
          const knownDefaults = Object.values(DEFAULT_EMBEDDING_URLS);
          if (!settings.embeddings.baseUrl || knownDefaults.includes(settings.embeddings.baseUrl)) {
            settings.embeddings.baseUrl = DEFAULT_EMBEDDING_URLS[kind];
            applyValues();
          }
        }
        void detectEmbeddingModels();
        return;
      }
      void loadModelsFor(target as ChatProviderKind);
    });
  });
}

async function main(): Promise<void> {
  settings = await getSettings();
  attachListeners();
  attachModelLoaders();
  applyValues();
  updateProviderHighlight();
  await loadDecks();
  applyValues();
  void autoLoadModels();
  void applyAndReportShortcuts();
  document.addEventListener("keydown", onShortcutKeydown, true);

  document.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement)?.closest<HTMLElement>("[data-action]");
    if (!el) return;
    event.preventDefault();
    void handleAction(el.dataset.action as string, el);
  });

  const providerSelect = document.getElementById("activeProvider");
  providerSelect?.addEventListener("change", () => {
    updateProviderHighlight();
    void loadModelsFor(settings.activeProvider);
  });

  void browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      void getSettings().then((next) => {
        settings = next;
        applyValues();
        updateProviderHighlight();
      });
    }
  });
}

void main();
