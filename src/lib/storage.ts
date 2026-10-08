import type { Settings } from "./types";

const SETTINGS_KEY = "settings";
const INDEX_KEY = "deckIndex";
const QUEUE_KEY = "queue";
const RECENT_KEY = "recentBatches";
const ANNOTATIONS_KEY = "annotations";
const HYPOTHESIS_SEEN_KEY = "hypothesisSeen";

export const DEFAULT_SETTINGS: Settings = {
  activeProvider: "opencode-go",
  providers: {
    "opencode-go": {
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "deepseek-v4.1-flash",
      apiKey: "",
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.1",
      apiKey: "",
    },
    vllm: {
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "",
      apiKey: "",
    },
  },
  providerStrategy: {
    preferLocal: false,
    localOnlyWhenCharging: true,
    fallbackToLocalWhenOffline: true,
    localProvider: "ollama",
    chargingOverride: "auto",
    maxConcurrentRequests: 3,
  },
  embeddings: {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    apiKey: "",
  },
  routing: {
    threshold: 0.75,
    fallbackDeck: "01 Seedbox",
    exclusions: ["Default"],
    deckDescriptions: {},
  },
  cards: {
    maxCards: 3,
    bloomLevel: "remember",
    temperature: 0.3,
    maxClozeWords: 2,
    reasoningEffort: "low",
  },
  context: {
    paragraphsBefore: 1,
    paragraphsAfter: 1,
  },
  anki: {
    endpoint: "http://127.0.0.1:8765",
    noteModel: "Cloze",
    textField: "Text",
    backExtraField: "Back Extra",
  },
  triggers: {
    floatingButton: true,
    allowContextInBackExtra: true,
    warnOnUnload: true,
  },
  flow: {
    mode: "immediate",
  },
  shortcuts: {
    capture: "Alt+Shift+A",
    edit: "Alt+Shift+E",
    toggleMarkers: "Alt+Shift+M",
    autogen: "Alt+Shift+G",
  },
  images: {
    enabled: true,
    noteModel: "Basic (and reversed card)",
    oneWayModel: "Basic",
    frontField: "Front",
    backField: "Back",
    defaultImageSide: "front",
    defaultBothDirections: true,
    maxImageMB: 8,
    downscale: false,
    maxDimension: 1600,
    visionIdentifier: false,
  },
  annotations: {
    showMarkers: true,
    normalizedUrls: true,
  },
  hypothesis: {
    mode: "off",
    apiToken: "",
    pollSeconds: 15,
    includeNoteText: true,
  },
  autogen: {
    defaultCount: 8,
  },
  queuePollSeconds: 20,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge stored settings over defaults so new keys always exist. */
export function mergeSettings(partial: unknown): Settings {
  const merge = (base: unknown, override: unknown): unknown => {
    if (!isPlainObject(base)) return override === undefined ? base : override;
    if (!isPlainObject(override)) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      out[key] = isPlainObject(base[key]) ? merge(base[key], value) : value;
    }
    return out;
  };
  const merged = merge(DEFAULT_SETTINGS, partial) as Settings;
  // Enforce the global rule: a cloze hides at most 2 words, even if an older
  // saved setting allowed more.
  const requested = Number(merged.cards.maxClozeWords);
  merged.cards.maxClozeWords = Math.min(2, Math.max(1, Number.isFinite(requested) ? requested : 2));
  return merged;
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getRaw<T>(key: string): Promise<T | undefined> {
  const stored = await browser.storage.local.get(key);
  return stored[key] as T | undefined;
}

export async function setRaw(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

export async function removeRaw(key: string): Promise<void> {
  await browser.storage.local.remove(key);
}

export const keys = {
  SETTINGS_KEY,
  INDEX_KEY,
  QUEUE_KEY,
  RECENT_KEY,
  ANNOTATIONS_KEY,
  HYPOTHESIS_SEEN_KEY,
};
