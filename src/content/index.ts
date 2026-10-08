import { JobPanel } from "../preview/panel";
import { ReviewBoard } from "../preview/review";
import { MarkerLayer } from "./markers";
import { anchorFromImage, anchorFromRange, fuzzyQuote, getPageText, locateAnchor } from "../lib/anchor";
import { contentKey } from "../lib/hypothesis";
import { escapeHtml } from "../lib/anki";
import { getSettings } from "../lib/storage";
import type {
  CapturePayload,
  CardFlowMode,
  FinalCard,
  HypothesisAnnotation,
  ImageCaptureData,
  Message,
  MessageResponse,
  PageAnchor,
  RoutedCard,
  Settings,
} from "../lib/types";

const BUTTON_HOST_ID = "anki-cloze-capture-button";
const TOAST_HOST_ID = "anki-cloze-capture-toast";

type JobMeta =
  | { kind: "text"; payload: CapturePayload; label: string; anchor?: PageAnchor }
  | { kind: "image"; payload: ImageCaptureData; label: string; anchor?: PageAnchor };

let settings: Settings | null = null;
let jobPanel: JobPanel | null = null;
let board: ReviewBoard | null = null;
let markers: MarkerLayer | null = null;
const jobMeta = new Map<string, JobMeta>();
let pendingSelection: { text: string; context: string; anchor?: PageAnchor } | null = null;
let pendingImage: HTMLImageElement | null = null;
let lastImage: HTMLImageElement | null = null;
let buttonHost: HTMLDivElement | null = null;
let hypObserver: MutationObserver | null = null;
let hypTimer: ReturnType<typeof setInterval> | null = null;
let hypBaselineDone = false;
const hypDomSeen = new Set<string>();
const boardJobs = new Set<string>();

function flowMode(): CardFlowMode {
  return settings?.flow.mode ?? "immediate";
}

function newJobId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function createButtonHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.id = BUTTON_HOST_ID;
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; display:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      button { font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background:#3b6fd4; color:#fff; border:none; border-radius:7px; padding:7px 10px; cursor:pointer;
        box-shadow:0 4px 14px rgba(0,0,0,.35); }
      button:hover { background:#4a7ee0; }
    </style>
    <button type="button">＋ Anki cloze</button>`;
  shadow.querySelector("button")?.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void triggerCapture(true);
  });
  document.documentElement.appendChild(host);
  return host;
}

function ensureButton(): HTMLDivElement {
  if (!buttonHost || !document.documentElement.contains(buttonHost)) {
    buttonHost = createButtonHost();
  }
  return buttonHost;
}

function hideButton(): void {
  const host = buttonHost ?? (document.getElementById(BUTTON_HOST_ID) as HTMLDivElement | null);
  if (host) host.style.display = "none";
}

function showButton(rect: { top: number; left: number; width: number }): void {
  const host = ensureButton();
  host.style.display = "block";
  const top = Math.max(8, rect.top - 40);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - 60), window.innerWidth - 140);
  host.style.top = `${top}px`;
  host.style.left = `${left}px`;
}

// --- text selection ---

function blockOf(node: Node | null): HTMLElement | null {
  let el: Element | null =
    node && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
  const blockTags = /^(P|LI|BLOCKQUOTE|TD|TH|DD|DT|PRE|FIGCAPTION|H[1-6]|ARTICLE|SECTION)$/;
  while (el && el !== document.body) {
    if (blockTags.test(el.tagName)) return el as HTMLElement;
    el = el.parentElement;
  }
  return (node?.parentElement as HTMLElement | null) ?? null;
}

function collectContext(range: Range, before: number, after: number): string {
  const block = blockOf(range.startContainer) ?? blockOf(range.endContainer);
  if (!block) return "";
  const parts: string[] = [];

  let count = 0;
  let el = block.previousElementSibling;
  const prev: string[] = [];
  while (el && count < before) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      prev.unshift(text);
      count += 1;
    }
    el = el.previousElementSibling;
  }
  parts.push(...prev);

  count = 0;
  el = block.nextElementSibling;
  while (el && count < after) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      parts.push(text);
      count += 1;
    }
    el = el.nextElementSibling;
  }

  return parts.join("\n\n").slice(0, 4000);
}

function readSelection(): { text: string; context: string; rect: DOMRect | null; anchor?: PageAnchor } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const before = settings?.context.paragraphsBefore ?? 1;
  const after = settings?.context.paragraphsAfter ?? 1;
  let context = "";
  try {
    context = collectContext(range, before, after);
  } catch {
    context = "";
  }
  let anchor: PageAnchor | undefined;
  try {
    anchor = anchorFromRange(range);
  } catch {
    anchor = undefined;
  }
  const rect = range.getBoundingClientRect();
  return { text, context, rect, anchor };
}

// --- image capture ---

function imageContext(img: HTMLImageElement): { caption: string; context: string } {
  let caption = "";
  const figure = img.closest("figure");
  const figcaption = figure?.querySelector("figcaption")?.textContent;
  if (figcaption) caption = figcaption.replace(/\s+/g, " ").trim();

  let heading = "";
  let node: Element | null = figure ?? img.parentElement;
  while (node && node !== document.body && !heading) {
    let prev = node.previousElementSibling;
    while (prev && !heading) {
      if (/^H[1-6]$/.test(prev.tagName)) {
        heading = (prev.textContent ?? "").trim();
      } else {
        const nested = prev.querySelector("h1,h2,h3,h4,h5,h6");
        if (nested?.textContent) heading = nested.textContent.trim();
      }
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
  }

  const owner = figure ?? img.closest("p, div, section, article") ?? img.parentElement;
  const paragraph = (owner?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const context = [heading, paragraph].filter(Boolean).join("\n\n");
  return { caption, context };
}

function findImageBySrc(src: string): HTMLImageElement | null {
  for (const img of Array.from(document.images)) {
    if (img.currentSrc === src || img.src === src) return img;
  }
  return null;
}

function buildImagePayload(img: HTMLImageElement | null, srcFallback?: string): ImageCaptureData {
  const srcUrl = img ? img.currentSrc || img.src : srcFallback ?? "";
  const ctx = img ? imageContext(img) : { caption: "", context: "" };
  return {
    srcUrl,
    alt: img?.alt ?? "",
    caption: ctx.caption,
    context: ctx.context,
    title: document.title,
    url: location.href,
    width: img?.naturalWidth,
    height: img?.naturalHeight,
  };
}

async function base64FromBlobUrl(url: string): Promise<{ dataBase64: string; mime: string } | null> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { dataBase64: btoa(binary), mime: blob.type || "image/png" };
  } catch {
    return null;
  }
}

async function captureImage(source?: string | HTMLImageElement | null): Promise<void> {
  if (!settings?.images.enabled) {
    showToast("Image cards are disabled in Settings.", "warn");
    return;
  }
  let img: HTMLImageElement | null = null;
  let srcFallback: string | undefined;
  if (source instanceof HTMLImageElement) img = source;
  else if (typeof source === "string" && source) {
    img = findImageBySrc(source);
    srcFallback = source;
  } else {
    img = lastImage;
  }
  if (!img && !srcFallback) {
    showToast("Click or right-click an image first.", "warn");
    return;
  }

  const payload = buildImagePayload(img, srcFallback);
  if (!payload.srcUrl) {
    showToast("Could not determine the image URL.", "warn");
    return;
  }
  if (payload.srcUrl.startsWith("blob:")) {
    const data = await base64FromBlobUrl(payload.srcUrl);
    if (data) {
      payload.dataBase64 = data.dataBase64;
      payload.mime = data.mime;
    }
  }

  const jobId = newJobId();
  const label = (payload.alt || payload.caption || payload.srcUrl.split("/").pop() || "image").slice(0, 80);
  let anchor: PageAnchor | undefined;
  try {
    if (img) anchor = anchorFromImage(img);
  } catch {
    anchor = undefined;
  }
  jobMeta.set(jobId, { kind: "image", payload, label, anchor });
  if (flowMode() === "collect") ensureBoard().incPending();
  else ensureJobPanel().addJob(jobId, payload.url, label);
  await browser.runtime.sendMessage({ type: "GENERATE_IMAGE_REQUEST", jobId, payload });
}

// --- panels ---

function ensureJobPanel(): JobPanel {
  if (!jobPanel) {
    jobPanel = new JobPanel({
      onAdd: (jobId, cards, url) => void addToAnki(jobId, cards, url),
      onRegenerate: (jobId) => void regenerate(jobId),
      onOpenOptions: () => void browser.runtime.sendMessage({ type: "OPEN_OPTIONS" }),
    });
    void refreshDecks();
  }
  return jobPanel;
}

function ensureBoard(): ReviewBoard {
  if (!board) {
    board = new ReviewBoard({
      onAdd: (groupId, cards, url) => addToAnkiCollect(groupId, cards, url),
      onRetry: (jobId) => void regenerate(jobId),
      onOpenOptions: () => void browser.runtime.sendMessage({ type: "OPEN_OPTIONS" }),
    });
    void refreshDecks();
  }
  return board;
}

/** Fetch the full deck list so the deck pickers offer every deck. */
async function refreshDecks(): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({ type: "GET_DECKS" })) as { decks?: string[] };
    if (response?.decks?.length) {
      jobPanel?.setDecks(response.decks);
      board?.setDecks(response.decks);
    }
  } catch {
    // Anki may be offline; keep whatever decks we already have.
  }
}

function ensureMarkers(): MarkerLayer {
  if (!markers) markers = new MarkerLayer();
  return markers;
}

// --- Hypothes.is integration ---

function hypothesisMode(): "off" | "api" | "dom" {
  const h = settings?.hypothesis;
  if (!h) return "off";
  if (h.mode === "off") return "off";
  if (h.mode === "api") return h.apiToken ? "api" : "off";
  if (h.mode === "dom") return "dom";
  return h.apiToken ? "api" : "dom";
}

function generateFromSource(input: {
  selection: string;
  context: string;
  anchor?: PageAnchor;
  noteText?: string;
  url: string;
  title: string;
}): void {
  const selection = input.selection.replace(/\s+/g, " ").trim();
  if (!selection) return;
  const jobId = newJobId();
  const payload: CapturePayload = {
    selection,
    context: input.context,
    title: input.title,
    url: input.url,
    noteText: input.noteText,
  };
  jobMeta.set(jobId, { kind: "text", payload, label: selection.slice(0, 80), anchor: input.anchor });
  if (flowMode() === "collect") ensureBoard().incPending();
  else ensureJobPanel().addJob(jobId, input.url, selection.slice(0, 80));
  void browser.runtime.sendMessage({ type: "GENERATE_REQUEST", jobId, payload });
}

function processHighlightElement(element: Element): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const exact = range.toString().replace(/\s+/g, " ").trim();
    if (!exact) return;
    const anchor = anchorFromRange(range);
    if (!anchor.quote) return;
    const key = contentKey(location.href, anchor);
    if (hypDomSeen.has(key)) return;
    hypDomSeen.add(key);
    if (!hypBaselineDone) return;
    const before = settings?.context.paragraphsBefore ?? 1;
    const after = settings?.context.paragraphsAfter ?? 1;
    let context = "";
    try {
      context = collectContext(range, before, after);
    } catch {
      context = "";
    }
    generateFromSource({
      selection: exact,
      context,
      anchor,
      url: location.href,
      title: document.title,
    });
  } catch {
    // ignore malformed highlights
  }
}

async function pollHypothesis(importAll = false): Promise<void> {
  let response: { ok: boolean; annotations?: HypothesisAnnotation[]; error?: string } | undefined;
  try {
    response = (await browser.runtime.sendMessage({
      type: "HYPOTHESIS_POLL",
      url: location.href,
      importAll,
    })) as { ok: boolean; annotations?: HypothesisAnnotation[]; error?: string };
  } catch {
    return;
  }
  if (!response?.ok) {
    if (importAll && response?.error) showToast(`Hypothes.is: ${response.error}`, "error");
    return;
  }
  const annotations = response.annotations ?? [];
  if (importAll) {
    showToast(
      annotations.length ? `Importing ${annotations.length} Hypothes.is highlight${annotations.length === 1 ? "" : "s"}…` : "No new Hypothes.is highlights on this page.",
      annotations.length ? "ok" : "warn",
    );
  }
  for (const annotation of annotations) {
    const anchor: PageAnchor = {
      kind: "text",
      quote: annotation.exact,
      prefix: annotation.prefix,
      suffix: annotation.suffix,
    };
    let context = [annotation.prefix, annotation.suffix].filter(Boolean).join(" … ");
    try {
      const located = locateAnchor(anchor);
      if (located?.range) {
        const before = settings?.context.paragraphsBefore ?? 1;
        const after = settings?.context.paragraphsAfter ?? 1;
        context = collectContext(located.range, before, after) || context;
      }
    } catch {
      // keep prefix/suffix context
    }
    generateFromSource({
      selection: annotation.exact,
      context,
      anchor,
      noteText: settings?.hypothesis.includeNoteText ? annotation.noteText : undefined,
      url: location.href,
      title: document.title,
    });
  }
}

function stopHypothesis(): void {
  if (hypTimer) {
    clearInterval(hypTimer);
    hypTimer = null;
  }
  if (hypObserver) {
    hypObserver.disconnect();
    hypObserver = null;
  }
}

function startHypothesis(): void {
  stopHypothesis();
  const mode = hypothesisMode();
  if (mode === "off") return;
  if (mode === "api") {
    void pollHypothesis();
    const seconds = Math.max(5, settings?.hypothesis.pollSeconds ?? 15);
    hypTimer = setInterval(() => {
      if (!document.hidden) void pollHypothesis();
    }, seconds * 1000);
    return;
  }
  // DOM watch
  hypBaselineDone = false;
  hypDomSeen.clear();
  document.querySelectorAll("hypothesis-highlight").forEach(processHighlightElement);
  hypObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.matches("hypothesis-highlight")) processHighlightElement(el);
        el.querySelectorAll?.("hypothesis-highlight").forEach(processHighlightElement);
      }
    }
  });
  if (document.body) hypObserver.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    hypBaselineDone = true;
  }, 3000);
}

// --- autogenerate from the whole page ---

/** Locate a generated card's source text on the page so autogenerated cards get a mark too. */
function deriveCardAnchor(card: RoutedCard): PageAnchor {
  const plain = card.text
    .replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const candidates = [card.sourceQuote, plain].filter((c): c is string => Boolean(c && c.trim().length > 8));
  const pageText = getPageText(document.body);
  for (const candidate of candidates) {
    try {
      const exact = locateAnchor({ kind: "text", quote: candidate, prefix: "", suffix: "" });
      if (exact?.range) return anchorFromRange(exact.range);
      const fuzzy = fuzzyQuote(pageText, candidate);
      if (fuzzy) {
        const located = locateAnchor({ kind: "text", quote: fuzzy, prefix: "", suffix: "" });
        if (located?.range) return anchorFromRange(located.range);
      }
    } catch {
      // try the next candidate
    }
  }
  return { kind: "text", quote: "", prefix: "", suffix: "" };
}

function extractPageContent(): string {
  const root =
    document.querySelector("article, main, [role='main']") ??
    document.body;
  if (!root) return "";
  const blocks = Array.from(root.querySelectorAll("h1, h2, h3, p, li, blockquote, dd"))
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 40);
  const joined = blocks.join("\n\n");
  const fallback = (root.textContent ?? "").replace(/\s+/g, " ").trim();
  return (joined.length > 400 ? joined : fallback).slice(0, 12000);
}

function showAutogenPrompt(): Promise<number | null> {
  const fallbackCount = settings?.autogen.defaultCount ?? 8;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial; position:fixed; z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .box { position:fixed; right:18px; bottom:18px; width:300px; background:#1e1f24; color:#e7e7ea;
          border:1px solid #3a3c45; border-radius:12px; box-shadow:0 14px 44px rgba(0,0,0,.5); padding:14px;
          font:13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .title { font-weight:600; margin-bottom:8px; }
        label { font-size:12px; color:#9aa0ad; display:block; margin-bottom:4px; }
        input { width:100%; box-sizing:border-box; background:#1b1c21; color:#e7e7ea; border:1px solid #40424c;
          border-radius:7px; padding:7px 9px; font:13px inherit; margin-bottom:10px; }
        .row { display:flex; gap:8px; }
        button { flex:1; border:1px solid #454754; background:#2c2d35; color:#e7e7ea; border-radius:7px;
          padding:7px 10px; cursor:pointer; font-size:12px; }
        button.primary { background:#3b6fd4; border-color:#3b6fd4; color:#fff; }
        .note { color:#8f95a3; font-size:11px; margin-top:8px; }
      </style>
      <div class="box">
        <div class="title">Generate cards from this page</div>
        <label>How many cards?</label>
        <input type="number" min="1" max="30" value="${fallbackCount}" />
        <div class="row">
          <button data-x="cancel">Cancel</button>
          <button class="primary" data-x="go">Generate</button>
        </div>
        <div class="note">Reads the page, picks the most useful facts, and collects the cards in the review board.</div>
      </div>`;
    const finish = (value: number | null) => {
      host.remove();
      resolve(value);
    };
    const input = shadow.querySelector("input") as HTMLInputElement | null;
    shadow.querySelector('[data-x="cancel"]')?.addEventListener("click", () => finish(null));
    shadow.querySelector('[data-x="go"]')?.addEventListener("click", () => {
      const value = Number(input?.value);
      finish(Number.isFinite(value) ? Math.max(1, Math.min(30, Math.round(value))) : fallbackCount);
    });
    input?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") {
        const value = Number(input.value);
        finish(Number.isFinite(value) ? Math.max(1, Math.min(30, Math.round(value))) : fallbackCount);
      }
    });
    document.documentElement.appendChild(host);
    input?.focus();
    input?.select();
  });
}

async function runAutogen(): Promise<void> {
  const count = await showAutogenPrompt();
  if (!count) return;
  const content = extractPageContent();
  if (!content || content.length < 200) {
    showToast("Not enough readable text on this page to autogenerate cards.", "warn");
    return;
  }
  const jobId = newJobId();
  const payload: CapturePayload = {
    selection: content,
    context: "",
    title: document.title,
    url: location.href,
    autoGen: true,
    count,
  };
  jobMeta.set(jobId, { kind: "text", payload, label: `Whole page · up to ${count} cards` });
  boardJobs.add(jobId);
  ensureBoard().incPending();
  showToast(`Autogenerating up to ${count} cards…`, "ok");
  await browser.runtime.sendMessage({ type: "GENERATE_REQUEST", jobId, payload });
}

function importAllHypothesis(): void {
  if (hypothesisMode() === "dom") {
    hypBaselineDone = true;
    hypDomSeen.clear();
    const highlights = document.querySelectorAll("hypothesis-highlight");
    showToast(
      highlights.length ? `Importing ${highlights.length} Hypothes.is highlight${highlights.length === 1 ? "" : "s"}…` : "No Hypothes.is highlights on this page.",
      highlights.length ? "ok" : "warn",
    );
    highlights.forEach(processHighlightElement);
    return;
  }
  void pollHypothesis(true);
}

async function regenerate(jobId: string): Promise<void> {
  const meta = jobMeta.get(jobId);
  if (!meta) return;
  if (flowMode() === "collect") ensureBoard().incPending();
  else ensureJobPanel().setGenerating(jobId, "Retrying…");
  if (meta.kind === "image") {
    await browser.runtime.sendMessage({ type: "GENERATE_IMAGE_REQUEST", jobId, payload: meta.payload });
  } else {
    await browser.runtime.sendMessage({ type: "GENERATE_REQUEST", jobId, payload: meta.payload });
  }
}

async function triggerCapture(preferPending = false): Promise<void> {
  hideButton();
  const fresh = readSelection();
  const usePending = preferPending && pendingSelection;
  const data = usePending
    ? pendingSelection
    : fresh
      ? { text: fresh.text, context: fresh.context, anchor: fresh.anchor }
      : pendingSelection;

  if (!data || !data.text) {
    const image = pendingImage ?? lastImage;
    if (image) {
      await captureImage(image);
      return;
    }
    showToast("Select text or click an image first.", "warn");
    return;
  }

  const jobId = newJobId();
  const payload: CapturePayload = {
    selection: data.text,
    context: data.context,
    title: document.title,
    url: location.href,
  };
  jobMeta.set(jobId, { kind: "text", payload, label: data.text.slice(0, 80), anchor: data.anchor });
  if (flowMode() === "collect") ensureBoard().incPending();
  else ensureJobPanel().addJob(jobId, payload.url, data.text.slice(0, 80));
  await browser.runtime.sendMessage({ type: "GENERATE_REQUEST", jobId, payload });
}

async function addToAnki(jobId: string, cards: FinalCard[], url: string): Promise<void> {
  const activePanel = ensureJobPanel();
  const meta = jobMeta.get(jobId);
  activePanel.setAdding(jobId);
  try {
    const response = (await browser.runtime.sendMessage({
      type: "ADD_CARDS",
      jobId,
      cards,
      url,
      title: meta?.payload.title,
      anchor: meta?.anchor,
    })) as MessageResponse;
    if (response?.queued) {
      activePanel.setResult(jobId, "queued", `Queued ${cards.length} card${cards.length === 1 ? "" : "s"} — Anki is offline.`);
      showToast(`Queued ${cards.length} card${cards.length === 1 ? "" : "s"} — Anki is offline.`, "warn");
    } else if (response?.ok) {
      const added = Number(response.added ?? 0);
      const skipped = Number(response.skipped ?? 0);
      const deck = cards[0]?.deck ?? "";
      const parts = [`Added ${added} card${added === 1 ? "" : "s"}${deck ? ` to ${deck}` : ""}`];
      if (skipped > 0) parts.push(`${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`);
      activePanel.setResult(jobId, "added", `${parts.join(" · ")}.`);
      showToast(`${parts.join(" · ")}.`, added > 0 ? "ok" : "warn");
      jobMeta.delete(jobId);
      void ensureMarkers().refresh();
    } else {
      activePanel.setError(jobId, response?.error ?? "Could not add cards.");
      showToast(response?.error ?? "Could not add cards.", "error");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    activePanel.setError(jobId, message);
    showToast(message, "error");
  }
}

async function addToAnkiCollect(groupId: string, cards: FinalCard[], url: string) {
  const meta = jobMeta.get(groupId);
  try {
    const response = (await browser.runtime.sendMessage({
      type: "ADD_CARDS",
      jobId: groupId,
      cards,
      url,
      title: meta?.payload.title,
      anchor: meta?.anchor,
    })) as MessageResponse;
    const added = Number(response.added ?? 0);
    const skipped = Number(response.skipped ?? 0);
    if (response?.queued) {
      jobMeta.delete(groupId);
      showToast(`Queued ${cards.length} card${cards.length === 1 ? "" : "s"} — Anki is offline.`, "warn");
      return { ok: true, queued: true, added: 0, skipped, message: `Queued ${cards.length} card(s).` };
    }
    if (response?.ok) {
      jobMeta.delete(groupId);
      void ensureMarkers().refresh();
      const deck = cards[0]?.deck ?? "";
      const parts = [`Added ${added} card${added === 1 ? "" : "s"}${deck ? ` to ${deck}` : ""}`];
      if (skipped > 0) parts.push(`${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`);
      showToast(`${parts.join(" · ")}.`, added > 0 ? "ok" : "warn");
      return { ok: true, queued: false, added, skipped, message: parts.join(" · ") + "." };
    }
    const reason = response?.error ?? "Could not add cards.";
    showToast(reason, "error");
    return { ok: false, queued: false, added: 0, skipped: 0, error: reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(message, "error");
    return {
      ok: false,
      queued: false,
      added: 0,
      skipped: 0,
      error: message,
    };
  }
}

function showToast(message: string, kind: "ok" | "warn" | "error"): void {
  document.getElementById(TOAST_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TOAST_HOST_ID;
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; right:18px; bottom:18px;";
  const color = kind === "ok" ? "#2f5233" : kind === "warn" ? "#4a3a22" : "#5a2a2a";
  const text = kind === "ok" ? "#a7ecb0" : kind === "warn" ? "#f2c98a" : "#f2a1a1";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    .t { background:${color}; color:${text}; padding:10px 14px; border-radius:9px;
      font:13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow:0 8px 24px rgba(0,0,0,.4); max-width:340px; }</style>
    <div class="t">${escapeHtml(message)}</div>`;
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 3200);
}

// --- events ---

function elementImage(event: Event): HTMLImageElement | null {
  const target = event.target as HTMLElement | null;
  return (target?.closest?.("img") as HTMLImageElement | null) ?? null;
}

function onMouseUp(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest?.(`#${BUTTON_HOST_ID}`)) return;
  window.setTimeout(() => {
    const data = readSelection();
    if (data && data.text) {
      pendingSelection = { text: data.text, context: data.context, anchor: data.anchor };
      pendingImage = null;
      if (data.rect && settings?.triggers.floatingButton) showButton(data.rect);
      return;
    }
    const img = elementImage(event);
    if (img && settings?.images.enabled && settings?.triggers.floatingButton) {
      lastImage = img;
      pendingImage = img;
      pendingSelection = null;
      showButton(img.getBoundingClientRect());
      return;
    }
    hideButton();
    pendingSelection = null;
    pendingImage = null;
  }, 10);
}

function onMouseDown(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest?.(`#${BUTTON_HOST_ID}`)) return;
  const img = elementImage(event);
  if (img) lastImage = img;
  hideButton();
  pendingSelection = null;
  pendingImage = null;
}

document.addEventListener("contextmenu", (event) => {
  const img = elementImage(event);
  if (img) lastImage = img;
});

browser.runtime.onMessage.addListener((message: Message) => {
  const collectDefault = flowMode() === "collect";
  const collectJob = (jobId: string) => collectDefault || boardJobs.has(jobId);
  switch (message.type) {
    case "START_CAPTURE":
      void triggerCapture(false);
      break;
    case "START_IMAGE_CAPTURE":
      void captureImage(message.srcUrl ?? null);
      break;
    case "START_HYPOTHESIS_IMPORT":
      importAllHypothesis();
      break;
    case "START_AUTOGEN":
      void runAutogen();
      break;
    case "TOGGLE_EDIT":
      if (!collectDefault) ensureJobPanel().toggleLatestEdit();
      else ensureBoard().setExpanded(true);
      break;
    case "SHOW_LOADING":
      if (!collectJob(message.jobId)) ensureJobPanel().setGenerating(message.jobId, message.note);
      break;
    case "SHOW_PREVIEW": {
      void refreshDecks();
      if (collectJob(message.jobId)) {
        const meta = jobMeta.get(message.jobId);
        const activeBoard = ensureBoard();
        activeBoard.decPending();
        const cards = message.cards as RoutedCard[];
        if (boardJobs.has(message.jobId)) {
          for (const card of cards) card.anchor = deriveCardAnchor(card);
        }
        activeBoard.addGroup(
          message.jobId,
          meta?.payload.url ?? location.href,
          meta?.label ?? message.jobId,
          cards,
          message.note,
        );
        if (boardJobs.has(message.jobId)) {
          activeBoard.setExpanded(true);
          boardJobs.delete(message.jobId);
        }
      } else {
        ensureJobPanel().setPreview(
          message.jobId,
          message.cards as RoutedCard[],
          message.decks,
          message.fallbackDeck,
          message.note,
        );
      }
      break;
    }
    case "SHOW_ERROR": {
      if (collectJob(message.jobId)) {
        const meta = jobMeta.get(message.jobId);
        const activeBoard = ensureBoard();
        activeBoard.decPending();
        activeBoard.addError(message.jobId, meta?.label ?? message.jobId, message.message);
        if (boardJobs.has(message.jobId)) {
          activeBoard.setExpanded(true);
          boardJobs.delete(message.jobId);
        }
      } else {
        ensureJobPanel().setError(message.jobId, message.message);
      }
      break;
    }
    default:
      break;
  }
  return undefined;
});

document.addEventListener("mouseup", onMouseUp, true);
document.addEventListener("mousedown", onMouseDown, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (flowMode() === "collect") {
      if (board?.isExpanded()) board.setExpanded(false);
    } else if (jobPanel?.isOpen()) {
      jobPanel.dismissNewest();
    }
    hideButton();
  }
});
window.addEventListener("scroll", hideButton, true);

/** Warn before closing/reloading a tab that still has unsaved cards. */
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!settings?.triggers.warnOnUnload) return;
  const unsaved = (jobPanel?.hasUnsaved() ?? false) || (board?.hasUnsaved() ?? false);
  if (!unsaved) return;
  event.preventDefault();
  event.returnValue = "";
}
window.addEventListener("beforeunload", onBeforeUnload);

void (async () => {
  settings = await getSettings();
  ensureMarkers().setEnabled(settings.annotations.showMarkers);
  startHypothesis();

  // Recover page markers from Anki (cards added before anchoring still show in the floater).
  if (settings.annotations.showMarkers) {
    setTimeout(() => {
      void (async () => {
        try {
          const response = (await browser.runtime.sendMessage({
            type: "REBUILD_ANNOTATIONS",
            url: location.href,
          })) as { ok: boolean; created?: number };
          if (response?.created) void ensureMarkers().refresh(location.href);
        } catch {
          // ignore (Anki offline, etc.)
        }
      })();
    }, 1800);
  }

  let lastHref = location.href;
  const checkUrl = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      void ensureMarkers().refresh(location.href);
      startHypothesis();
    }
  };
  window.addEventListener("popstate", checkUrl);
  window.setInterval(checkUrl, 2000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && hypothesisMode() === "api") void pollHypothesis();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      void getSettings().then((next) => {
        const wasEnabled = settings?.annotations.showMarkers;
        const prevHypothesis = JSON.stringify(settings?.hypothesis ?? null);
        settings = next;
        if (!next.triggers.floatingButton) hideButton();
        if (next.annotations.showMarkers !== wasEnabled) ensureMarkers().setEnabled(next.annotations.showMarkers);
        if (JSON.stringify(next.hypothesis) !== prevHypothesis) startHypothesis();
      });
    }
  });
})();
