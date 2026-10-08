import { addCards, ankiVersion, deckNames, ensureDeck, findNotes, notesInfo, updateNoteFields } from "../lib/anki";
import { addAnnotation, listAnnotations, normalizeUrl, removeAnnotation } from "../lib/annotations";
import { clearSeen, contentKey, fetchAnnotations, getProfile, getSeen, setSeen } from "../lib/hypothesis";
import { routeDeck, rebuildDeckIndex } from "../lib/decks";
import { chat, chatVision } from "../lib/llm";
import { fetchImageBytes, base64ToBytes, downscaleImage } from "../lib/media";
import { buildMessages } from "../lib/prompt";
import { parseCardResponse } from "../lib/quality";
import { addRecent, clearQueue, enqueue, flushQueue, listRecent, undoRecent } from "../lib/queue";
import { getSettings, saveSettings } from "../lib/storage";
import { applyShortcuts } from "../lib/shortcuts";
import { providerLabel, readPowerState, resolveProviderChain } from "../lib/strategy";
import type {
  Annotation,
  CapturePayload,
  ChatProviderKind,
  FinalCard,
  HypothesisAnnotation,
  ImageCaptureData,
  Message,
  MessageResponse,
  PageAnchor,
  RoutedCard,
  Settings,
} from "../lib/types";

const MENU_ID = "anki-cloze-capture";
const IMAGE_MENU_ID = "anki-cloze-capture-image";
const FLUSH_ALARM = "anki-cloze-capture-flush";

async function sendToTab(tabId: number, message: Message): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch {
    // The tab may have navigated or the content script may not be present.
  }
}

async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function notify(title: string, message: string): Promise<void> {
  try {
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icon-96.png"),
      title,
      message,
    });
  } catch {
    // Notifications are best-effort.
  }
}

function routingText(payload: CapturePayload, cards: { text: string }[]): string {
  return [payload.selection, ...cards.map((c) => c.text.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, "$1"))]
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .slice(0, 2500);
}

async function resolveDecks(settings: Settings): Promise<string[]> {
  try {
    const decks = await deckNames(settings.anki.endpoint);
    if (decks.length > 0) return decks;
  } catch {
    // fall through
  }
  return [settings.routing.fallbackDeck];
}

type GenerateJob =
  | { kind: "text"; jobId: string; payload: CapturePayload; tabId: number }
  | { kind: "image"; jobId: string; payload: ImageCaptureData; tabId: number };

const generateQueue: GenerateJob[] = [];
let activeGenerations = 0;
let pumping = false;

async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const settings = await getSettings();
    const max = Math.max(1, Math.min(8, settings.providerStrategy.maxConcurrentRequests || 1));
    while (activeGenerations < max && generateQueue.length > 0) {
      const job = generateQueue.shift() as GenerateJob;
      activeGenerations += 1;
      const run = job.kind === "image"
        ? handleGenerateImage(job.payload, job.tabId, job.jobId)
        : handleGenerate(job.payload, job.tabId, job.jobId);
      void run.finally(() => {
        activeGenerations -= 1;
        void pumpQueue();
      });
    }
  } finally {
    pumping = false;
  }
}

function enqueueGenerate(job: GenerateJob): void {
  generateQueue.push(job);
  void pumpQueue();
}

/** Best-effort identifier text from the image's surrounding page context. */
function suggestIdentifier(payload: ImageCaptureData): string {
  const alt = (payload.alt ?? "").trim();
  if (alt && alt.length < 140 && !/^(image|photo|picture|img|figure|diagram|icon)\b/i.test(alt)) {
    return alt;
  }
  const caption = (payload.caption ?? "").trim();
  if (caption) return caption.slice(0, 200);
  const context = (payload.context ?? "").trim();
  if (context) {
    const sentence = context.split(/(?<=[.!?])\s+/)[0] ?? context;
    return sentence.slice(0, 200);
  }
  return (payload.title ?? "").slice(0, 200);
}

async function handleGenerateImage(payload: ImageCaptureData, tabId: number, jobId: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.images.enabled) {
    await sendToTab(tabId, { type: "SHOW_ERROR", jobId, message: "Image cards are disabled in Settings." });
    return;
  }
  await sendToTab(tabId, { type: "SHOW_LOADING", jobId, note: "Fetching image…" });

  let mime = payload.mime || "";
  let dataBase64 = payload.dataBase64 || "";
  let bytes = dataBase64 ? base64ToBytes(dataBase64).length : 0;

  if (!dataBase64) {
    try {
      const fetched = await fetchImageBytes(payload.srcUrl);
      mime = fetched.mime;
      dataBase64 = fetched.dataBase64;
      bytes = fetched.bytes;
    } catch (error) {
      await sendToTab(tabId, {
        type: "SHOW_ERROR",
        jobId,
        message: `Could not fetch the image: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }
  if (!mime) mime = "image/png";

  if (bytes > settings.images.maxImageMB * 1024 * 1024) {
    await sendToTab(tabId, { type: "SHOW_ERROR", jobId, message: `Image is larger than the ${settings.images.maxImageMB} MB limit.` });
    return;
  }

  if (settings.images.downscale) {
    const down = await downscaleImage(dataBase64, mime, settings.images.maxDimension);
    if (down) {
      dataBase64 = down.dataBase64;
      mime = down.mime;
    }
  }

  let text = suggestIdentifier(payload);
  let providerNote = "page context";
  if (settings.images.visionIdentifier) {
    try {
      const power = await readPowerState(settings);
      const chain = resolveProviderChain(settings, power);
      const kind = chain[0]?.kind;
      const answer = await chatVision(
        settings,
        "Describe this image in a short noun phrase (max 8 words) suitable as the answer on a flashcard. Reply with the phrase only.",
        `data:${mime};base64,${dataBase64}`,
        { providerKind: kind, maxTokens: 60, reasoningEffort: "none" },
      );
      const cleaned = answer.trim().replace(/^["']|["']$/g, "");
      if (cleaned) {
        text = cleaned;
        providerNote = "vision";
      }
    } catch {
      // fall back to the page-context suggestion
    }
  }

  const decks = await resolveDecks(settings);
  const routingBasis = `${text} ${payload.alt ?? ""} ${payload.title ?? ""} ${payload.context ?? ""}`.slice(0, 2000);
  let routedDeck = settings.routing.fallbackDeck;
  let confidence = 0;
  try {
    const route = await routeDeck(settings, decks, routingBasis);
    routedDeck = route.match.deck;
    confidence = route.match.confidence;
  } catch {
    routedDeck = settings.routing.fallbackDeck;
  }

  const cards: RoutedCard[] = [
    {
      kind: "image",
      text,
      backExtra: payload.context ?? "",
      deck: routedDeck,
      confidence,
      imageSide: settings.images.defaultImageSide,
      bothDirections: settings.images.defaultBothDirections,
      image: {
        sourceUrl: payload.srcUrl,
        mime,
        dataBase64,
        width: payload.width,
        height: payload.height,
        alt: payload.alt,
      },
    },
  ];

  await sendToTab(tabId, {
    type: "SHOW_PREVIEW",
    jobId,
    cards,
    decks,
    fallbackDeck: settings.routing.fallbackDeck,
    note: `${providerLabel(settings.activeProvider)} · ${providerNote}`,
  });
}

async function handleGenerate(payload: CapturePayload, tabId: number, jobId: string): Promise<void> {
  const settings = await getSettings();
  const power = await readPowerState(settings);
  const chain = resolveProviderChain(settings, power);
  const primary = chain[0];
  await sendToTab(tabId, {
    type: "SHOW_LOADING",
    jobId,
    note: primary ? `${providerLabel(primary.kind)} · ${primary.reason}` : undefined,
  });

  const maxTokens = Math.max(3000, Math.min(12000, 1000 + settings.cards.maxCards * 700));
  const genSettings: Settings =
    payload.autoGen && payload.count
      ? { ...settings, cards: { ...settings.cards, maxCards: Math.max(1, Math.min(30, payload.count)) } }
      : settings;
  const genMaxTokens = payload.autoGen
    ? Math.max(3000, Math.min(14000, 1000 + genSettings.cards.maxCards * 700))
    : maxTokens;
  const enrichedPayload: CapturePayload = payload.noteText
    ? { ...payload, context: [payload.context, `Annotation note: ${payload.noteText}`].filter(Boolean).join("\n\n") }
    : payload;
  let raw = "";
  let usedKind: ChatProviderKind | null = null;
  let lastError: unknown = null;

  for (const entry of chain) {
    try {
      raw = await chat(settings, buildMessages(genSettings, enrichedPayload), {
        maxTokens: genMaxTokens,
        providerKind: entry.kind,
      });
      usedKind = entry.kind;
      break;
    } catch (error) {
      lastError = error;
      // Try the next provider in the chain.
    }
  }

  if (!raw) {
    await sendToTab(tabId, {
      type: "SHOW_ERROR",
      jobId,
      message: lastError instanceof Error ? lastError.message : "All providers failed",
    });
    return;
  }

  const parsed = parseCardResponse(raw, settings.cards.maxClozeWords);
  if (parsed.error || parsed.cards.length === 0) {
    await sendToTab(tabId, { type: "SHOW_ERROR", jobId, message: parsed.error ?? "No cards were generated" });
    return;
  }

  const decks = await resolveDecks(settings);
  let routedDeck = settings.routing.fallbackDeck;
  let confidence = 0;
  try {
    const route = await routeDeck(settings, decks, routingText(payload, parsed.cards));
    routedDeck = route.match.deck;
    confidence = route.match.confidence;
  } catch {
    routedDeck = settings.routing.fallbackDeck;
  }

  const cards: RoutedCard[] = parsed.cards.map((card) => ({
    text: card.text,
    backExtra: payload.noteText ? [payload.noteText, card.backExtra].filter(Boolean).join("<br><br>") : card.backExtra,
    sourceQuote: card.sourceQuote,
    deck: routedDeck,
    confidence,
    issues: card.issues,
  }));

  await sendToTab(tabId, {
    type: "SHOW_PREVIEW",
    jobId,
    cards,
    decks,
    fallbackDeck: settings.routing.fallbackDeck,
    note: usedKind ? providerLabel(usedKind) : undefined,
  });
}

function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

async function recordAnnotation(
  settings: Settings,
  url: string,
  title: string,
  cards: FinalCard[],
  anchor: PageAnchor | undefined,
  noteIds: number[],
): Promise<void> {
  if (!anchor || noteIds.length === 0) return;
  const first = cards[0];
  const rawPreview = first?.kind === "image" ? first.text || "Image" : first?.text ?? "";
  const annotation: Annotation = {
    id: crypto.randomUUID(),
    url,
    urlKey: normalizeUrl(url, settings.annotations.normalizedUrls),
    title: title || url,
    createdAt: Date.now(),
    noteIds,
    cardKind: first?.kind === "image" ? "image" : "cloze",
    deck: first?.deck ?? settings.routing.fallbackDeck,
    preview: truncateWords(rawPreview.replace(/<[^>]+>/g, ""), 160),
    anchor,
  };
  await addAnnotation(annotation);
}

async function handleAdd(
  cards: FinalCard[],
  url: string,
  title: string | undefined,
  anchor: PageAnchor | undefined,
): Promise<MessageResponse> {
  const settings = await getSettings();
  const uniqueDecks = [...new Set(cards.map((c) => c.deck).filter(Boolean))];

  try {
    for (const deck of uniqueDecks) {
      await ensureDeck(settings.anki.endpoint, deck);
    }
    const result = await addCards(settings.anki.endpoint, cards, settings, url);

    if (result.noteIds.length > 0) {
      await addRecent({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        noteIds: result.noteIds,
        deck: uniqueDecks[0] ?? settings.routing.fallbackDeck,
        count: result.added,
        url,
      });
      const pageAnchor: PageAnchor = { kind: "text", quote: "", prefix: "", suffix: "" };
      if (cards.some((c) => c.anchor)) {
        // Autogenerated cards carry their own anchors → one annotation each.
        for (const ref of result.addedCards) {
          const card = cards[ref.index];
          if (!card) continue;
          await recordAnnotation(settings, url, title ?? url, [card], card.anchor ?? anchor ?? pageAnchor, [ref.noteId]);
        }
      } else if (result.addedCards.length > 0) {
        await recordAnnotation(
          settings,
          url,
          title ?? url,
          cards,
          anchor ?? pageAnchor,
          result.addedCards.map((ref) => ref.noteId),
        );
      }
    }

    const summary =
      result.added > 0
        ? `Added ${result.added} card${result.added === 1 ? "" : "s"}${result.skipped ? `, ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}.`
        : "All cards were duplicates and were skipped.";
    void notify(result.added > 0 ? "Anki cards added" : "Nothing added", summary);

    return {
      ok: true,
      added: result.added,
      skipped: result.skipped,
      failed: result.failed,
      queued: false,
      message: summary,
      noteIds: result.noteIds,
    };
  } catch (error) {
    await enqueue(cards, url, anchor, title);
    const message = error instanceof Error ? error.message : String(error);
    void notify("Cards queued", "Anki is unavailable. Cards were queued and will sync automatically.");
    return { ok: true, added: 0, skipped: 0, failed: 0, queued: true, message };
  }
}

let hypProfileCache: { token: string; userid?: string } | null = null;

async function hypUserId(token: string): Promise<string | undefined> {
  if (hypProfileCache?.token === token) return hypProfileCache.userid;
  const profile = await getProfile(token);
  hypProfileCache = { token, userid: profile.ok ? profile.userid : undefined };
  return hypProfileCache.userid;
}

interface HypothesisPollResult {
  ok: boolean;
  annotations: HypothesisAnnotation[];
  error?: string;
  baselined?: boolean;
}

async function handleHypothesisPoll(url: string, importAll: boolean): Promise<HypothesisPollResult> {
  const settings = await getSettings();
  const token = settings.hypothesis.apiToken;
  if (!token) return { ok: false, annotations: [], error: "Hypothes.is API token not set" };
  const result = await fetchAnnotations(token, url, await hypUserId(token));
  if (!result.ok) return { ok: false, annotations: [], error: result.error };
  const urlKey = normalizeUrl(url, settings.annotations.normalizedUrls);
  const anchorOf = (a: HypothesisAnnotation): PageAnchor => ({
    kind: "text",
    quote: a.exact,
    prefix: a.prefix,
    suffix: a.suffix,
  });
  const seen = await getSeen(urlKey);
  const known = new Set(seen.ids);
  const unseen = result.annotations.filter(
    (a) => !known.has(a.id) && !known.has(contentKey(urlKey, anchorOf(a))),
  );
  if (!seen.initialized && !importAll) {
    const baseline = result.annotations.flatMap((a) => [a.id, contentKey(urlKey, anchorOf(a))]);
    await setSeen(urlKey, { initialized: true, ids: [...known, ...baseline] });
    return { ok: true, annotations: [], baselined: true };
  }
  const marked = unseen.flatMap((a) => [a.id, contentKey(urlKey, anchorOf(a))]);
  await setSeen(urlKey, { initialized: true, ids: [...known, ...marked] });
  return { ok: true, annotations: unseen };
}

function stripHtmlAndCloze(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/(?:<br\s*\/?>\s*)*Source:\s*<a\s[^>]*>.*?<\/a>/gi, " ")
    .replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickNoteText(fields: Record<string, string>): string {
  if (fields.Text) return fields.Text;
  for (const [name, value] of Object.entries(fields)) {
    if (/front|back|occlusion/i.test(name) && value && !/<img/i.test(value)) return value;
  }
  return "";
}

/**
 * Recover page annotations from Anki: find notes whose Source URL matches this
 * page, so cards added before anchoring still show up in the floater.
 */
async function handleRebuildAnnotations(url: string): Promise<{ ok: boolean; created: number; error?: string }> {
  const settings = await getSettings();
  const endpoint = settings.anki.endpoint;
  // Anki's search tokenizer breaks on "://", so search the scheme-less URL.
  const bare = url.replace(/^https?:\/\//i, "").replace(/#.*$/, "");
  let noteIds: number[] = [];
  try {
    noteIds = await findNotes(endpoint, `"${bare}"`);
    if (noteIds.length === 0) noteIds = await findNotes(endpoint, `"${bare.replace(/\/$/, "")}"`);
  } catch (error) {
    return { ok: false, created: 0, error: error instanceof Error ? error.message : String(error) };
  }
  if (noteIds.length === 0) return { ok: true, created: 0 };
  const existing = await listAnnotations(url, settings.annotations.normalizedUrls);
  const known = new Set(existing.flatMap((a) => a.noteIds));
  const fresh = noteIds.filter((id) => !known.has(id)).slice(0, 300);
  if (fresh.length === 0) return { ok: true, created: 0 };
  let notes: Awaited<ReturnType<typeof notesInfo>> = [];
  try {
    notes = await notesInfo(endpoint, fresh);
  } catch {
    return { ok: true, created: 0 };
  }
  const urlKey = normalizeUrl(url, settings.annotations.normalizedUrls);
  const bareLower = bare.toLowerCase();
  const pageAnchor: PageAnchor = { kind: "text", quote: "", prefix: "", suffix: "" };
  let created = 0;
  for (const note of notes) {
    // Verify the note actually references this URL (avoid phrase-search false positives).
    const references = Object.values(note.fields).some((value) => value.toLowerCase().includes(bareLower));
    if (!references) continue;
    const text = stripHtmlAndCloze(pickNoteText(note.fields));
    if (!text) continue;
    await addAnnotation({
      id: crypto.randomUUID(),
      url,
      urlKey,
      title: url,
      createdAt: Date.now(),
      noteIds: [note.noteId],
      cardKind: "cloze",
      deck: "",
      preview: truncateWords(text, 160),
      anchor: pageAnchor,
    });
    created += 1;
  }
  return { ok: true, created };
}

async function handleRebuildIndex(): Promise<MessageResponse> {
  const settings = await getSettings();
  let decks: string[];
  try {
    decks = await deckNames(settings.anki.endpoint);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const index = await rebuildDeckIndex(settings, decks);
    return { ok: true, count: index.decks.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function flushQueueSafe(): Promise<void> {
  const settings = await getSettings();
  const result = await flushQueue(settings, async (item, noteIds) => {
    await recordAnnotation(settings, item.url, item.title ?? item.url, item.cards, item.anchor, noteIds);
  });
  if (result.flushed > 0) {
    void notify("Queued cards synced", `Added ${result.added} card${result.added === 1 ? "" : "s"} from the queue.`);
  }
}

function registerContextMenu(): void {
  void browser.menus.removeAll().then(() => {
    browser.menus.create({
      id: MENU_ID,
      title: "Create Anki cloze card",
      contexts: ["selection"],
    });
    browser.menus.create({
      id: IMAGE_MENU_ID,
      title: "Create Anki image card",
      contexts: ["image"],
    });
  });
}

async function ensureAlarm(): Promise<void> {
  const settings = await getSettings();
  const period = Math.max(1, Math.round(settings.queuePollSeconds / 60) || 1);
  await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: period });
}

async function applyStoredShortcuts(): Promise<void> {
  const settings = await getSettings();
  await applyShortcuts(settings.shortcuts);
}

browser.runtime.onInstalled.addListener(() => {
  registerContextMenu();
  void ensureAlarm();
  void applyStoredShortcuts();
  void flushQueueSafe();
});

browser.runtime.onStartup.addListener(() => {
  registerContextMenu();
  void ensureAlarm();
  void applyStoredShortcuts();
  void flushQueueSafe();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const before = JSON.stringify(changes.settings.oldValue?.shortcuts ?? null);
  const after = JSON.stringify(changes.settings.newValue?.shortcuts ?? null);
  if (before !== after) void applyStoredShortcuts();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === IMAGE_MENU_ID) {
    void sendToTab(tab.id, { type: "START_IMAGE_CAPTURE", srcUrl: info.srcUrl });
    return;
  }
  if (info.menuItemId !== MENU_ID) return;
  void sendToTab(tab.id, { type: "START_CAPTURE" });
});

browser.commands.onCommand.addListener((command) => {
  if (command === "capture-cloze") {
    void activeTab().then((tab) => {
      if (tab?.id !== undefined) void sendToTab(tab.id, { type: "START_CAPTURE" });
    });
  } else if (command === "toggle-edit") {
    void activeTab().then((tab) => {
      if (tab?.id !== undefined) void sendToTab(tab.id, { type: "TOGGLE_EDIT" });
    });
  } else if (command === "toggle-markers") {
    void getSettings().then(async (settings) => {
      settings.annotations.showMarkers = !settings.annotations.showMarkers;
      await saveSettings(settings);
    });
  } else if (command === "autogen-page") {
    void activeTab().then((tab) => {
      if (tab?.id !== undefined) void sendToTab(tab.id, { type: "START_AUTOGEN" });
    });
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) void flushQueueSafe();
});

browser.runtime.onMessage.addListener((message: Message, sender) => {
  switch (message.type) {
    case "GENERATE_REQUEST": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return Promise.resolve({ ok: false, error: "No tab context" });
      enqueueGenerate({ kind: "text", jobId: message.jobId, payload: message.payload, tabId });
      return Promise.resolve({ ok: true, queued: true, active: activeGenerations, pending: generateQueue.length });
    }
    case "GENERATE_IMAGE_REQUEST": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return Promise.resolve({ ok: false, error: "No tab context" });
      enqueueGenerate({ kind: "image", jobId: message.jobId, payload: message.payload, tabId });
      return Promise.resolve({ ok: true, queued: true, active: activeGenerations, pending: generateQueue.length });
    }
    case "ADD_CARDS":
      return handleAdd(message.cards, message.url, message.title, message.anchor);
    case "GET_DECKS": {
      return getSettings().then(async (settings) => {
        const decks = await resolveDecks(settings);
        return {
          ok: true,
          decks,
          fallbackDeck: settings.routing.fallbackDeck,
        };
      });
    }
    case "REBUILD_INDEX":
      return handleRebuildIndex();
    case "PING":
      return getSettings().then(async (settings) => {
        let anki = false;
        try {
          await ankiVersion(settings.anki.endpoint);
          anki = true;
        } catch {
          anki = false;
        }
        const power = await readPowerState(settings);
        const chain = resolveProviderChain(settings, power);
        const effective = chain[0];
        return {
          ok: true,
          anki,
          provider: settings.activeProvider,
          model: settings.providers[settings.activeProvider].model,
          effectiveProvider: effective?.kind ?? settings.activeProvider,
          strategyNote: effective?.reason,
        };
      });
    case "OPEN_OPTIONS":
      void browser.runtime.openOptionsPage();
      return Promise.resolve({ ok: true });
    case "FLUSH_QUEUE":
      return getSettings()
        .then((s) =>
          flushQueue(s, async (item, noteIds) => {
            await recordAnnotation(s, item.url, item.title ?? item.url, item.cards, item.anchor, noteIds);
          }),
        )
        .then((result) => ({ ok: true, ...result }));
    case "CLEAR_QUEUE":
      return clearQueue().then(() => ({ ok: true }));
    case "GET_RECENT":
      return listRecent().then((batches) => ({ ok: true, batches }));
    case "UNDO_BATCH":
      return getSettings()
        .then((s) => undoRecent(s, message.id))
        .then((removed) => ({ ok: true, removed }));
    case "GET_ANNOTATIONS":
      return getSettings().then(async (settings) => ({
        ok: true,
        annotations: await listAnnotations(message.url, settings.annotations.normalizedUrls),
      }));
    case "GET_NOTE_DETAILS":
      return getSettings().then(async (settings) => {
        try {
          const notes = await notesInfo(settings.anki.endpoint, message.noteIds);
          return { ok: true, notes };
        } catch (error) {
          return {
            ok: false,
            notes: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    case "UPDATE_NOTE":
      return getSettings().then(async (settings) => {
        try {
          await updateNoteFields(settings.anki.endpoint, message.noteId, message.fields);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    case "REMOVE_ANNOTATION":
      return getSettings().then(async (settings) => {
        await removeAnnotation(message.url, message.id, settings.annotations.normalizedUrls);
        return { ok: true };
      });
    case "REBUILD_ANNOTATIONS":
      return handleRebuildAnnotations(message.url);
    case "HYPOTHESIS_POLL":
      return handleHypothesisPoll(message.url, Boolean(message.importAll));
    case "HYPOTHESIS_TEST":
      return getSettings().then((settings) => {
        if (!settings.hypothesis.apiToken) return { ok: false, error: "No token set" };
        return getProfile(settings.hypothesis.apiToken);
      });
    case "HYPOTHESIS_CLEAR":
      return clearSeen().then(() => ({ ok: true }));
    default:
      return Promise.resolve({ ok: false, error: "Unknown message" });
  }
});

export {};
