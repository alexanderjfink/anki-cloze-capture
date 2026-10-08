import { mediaFilename } from "./media";
import type { AnkiNoteInfo, AnkiSettings, FinalCard, GeneratedCard, Settings } from "./types";

export class AnkiConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnkiConnectError";
  }
}

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function ankiRequest<T>(
  endpoint: string,
  action: string,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AnkiConnectError(`AnkiConnect HTTP ${response.status}`);
    }
    const data = (await response.json()) as AnkiResponse<T>;
    if (data.error) throw new AnkiConnectError(data.error);
    return data.result;
  } catch (error) {
    if (error instanceof AnkiConnectError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AnkiConnectError("AnkiConnect request timed out");
    }
    throw new AnkiConnectError(
      `Cannot reach AnkiConnect at ${endpoint}. Is Anki running with the AnkiConnect add-on?`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function ankiVersion(endpoint: string): Promise<number> {
  return ankiRequest<number>(endpoint, "version");
}

export async function deckNames(endpoint: string): Promise<string[]> {
  return ankiRequest<string[]>(endpoint, "deckNames");
}

export async function modelNames(endpoint: string): Promise<string[]> {
  return ankiRequest<string[]>(endpoint, "modelNames");
}

export async function modelFieldNames(endpoint: string, modelName: string): Promise<string[]> {
  return ankiRequest<string[]>(endpoint, "modelFieldNames", { modelName });
}

export async function ensureDeck(endpoint: string, deck: string): Promise<void> {
  const decks = await deckNames(endpoint);
  if (!decks.includes(deck)) {
    await ankiRequest(endpoint, "createDeck", { deck });
  }
}

/** Remove cloze syntax so the plain sentence can be used for routing/TTS. */
export function stripCloze(text: string): string {
  return text
    .replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the Back Extra field. The source line is always present and always
 * last: `Source: <a href="URL">URL</a>`. Context is optional and rendered above.
 */
export function buildBackExtra(context: string, url: string, allowContext: boolean): string {
  const safeUrl = escapeHtml(url);
  const source = `Source: <a href="${safeUrl}">${safeUrl}</a>`;
  const trimmed = context.trim();
  if (allowContext && trimmed) {
    return `${trimmed}<br><br>${source}`;
  }
  return source;
}

export function buildFields(
  card: Pick<FinalCard, "text" | "backExtra">,
  settings: AnkiSettings,
  url: string,
  allowContext: boolean,
): Record<string, string> {
  return {
    [settings.textField]: card.text,
    [settings.backExtraField]: buildBackExtra(card.backExtra, url, allowContext),
  };
}

export interface AddResult {
  added: number;
  skipped: number;
  failed: number;
  noteIds: number[];
}

export interface NoteSpec {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
}

export async function storeMediaFile(endpoint: string, filename: string, dataBase64: string): Promise<string> {
  return ankiRequest<string>(endpoint, "storeMediaFile", { filename, data: dataBase64 });
}

export async function mediaExists(endpoint: string, filename: string): Promise<boolean> {
  const names = await ankiRequest<string[]>(endpoint, "getMediaFilesNames", { pattern: filename });
  return names.includes(filename);
}

function clozeNote(card: FinalCard, settings: AnkiSettings, url: string, allowContext: boolean): NoteSpec {
  return {
    deckName: card.deck,
    modelName: settings.noteModel,
    fields: buildFields(card, settings, url, allowContext),
  };
}

/** Build the model + fields for an image card. Pure (no media calls) for testability. */
export function buildImageFields(
  card: FinalCard,
  settings: Settings,
  url: string,
  filename: string,
): { modelName: string; fields: Record<string, string> } {
  const imgHtml = `<img src="${escapeHtml(filename)}">`;
  const source = url ? `<br><br>Source: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : "";
  const textHtml = `${escapeHtml(card.text)}${source}`;
  const side = card.imageSide ?? settings.images.defaultImageSide;
  const front = side === "front" ? imgHtml : textHtml;
  const back = side === "front" ? textHtml : imgHtml;
  const both = card.bothDirections ?? settings.images.defaultBothDirections;
  const modelName = both ? settings.images.noteModel : settings.images.oneWayModel;
  return {
    modelName,
    fields: {
      [settings.images.frontField]: front,
      [settings.images.backField]: back,
    },
  };
}

/** Store the image (deduped) and build a Basic-style note with the source appended to the text side. */
async function imageNote(
  endpoint: string,
  card: FinalCard,
  settings: Settings,
  url: string,
): Promise<NoteSpec> {
  const image = card.image;
  if (!image) throw new Error("Image card has no image data");
  let filename = image.filename;
  if (!filename) {
    if (!image.dataBase64) throw new Error("Image bytes are missing");
    filename = await mediaFilename(image.dataBase64, image.mime);
    if (!(await mediaExists(endpoint, filename))) {
      await storeMediaFile(endpoint, filename, image.dataBase64);
    }
  }
  const { modelName, fields } = buildImageFields(card, settings, url, filename);
  return { deckName: card.deck, modelName, fields };
}

export interface AddedCardRef {
  index: number;
  noteId: number;
}

export interface AddCardsResult extends AddResult {
  addedCards: AddedCardRef[];
}

interface IndexedSpec {
  note: NoteSpec;
  index: number;
}

async function addIndexed(endpoint: string, specs: IndexedSpec[], timeoutMs = 30_000): Promise<AddCardsResult> {
  if (specs.length === 0) return { added: 0, skipped: 0, failed: 0, noteIds: [], addedCards: [] };
  const payload = specs.map((spec) => ({
    ...spec.note,
    options: { allowDuplicate: false, duplicateScope: "deck" },
  }));

  // AnkiConnect raises an error for an all-duplicate batch instead of returning
  // null, so pre-filter duplicates to keep batches (and the offline queue) sane.
  let allowed: boolean[] = payload.map(() => true);
  let duplicates = 0;
  try {
    const canAdd = await ankiRequest<boolean[]>(endpoint, "canAddNotes", { notes: payload }, timeoutMs);
    if (Array.isArray(canAdd) && canAdd.length === payload.length) {
      allowed = canAdd.map((v) => v !== false);
      duplicates = allowed.filter((v) => !v).length;
    }
  } catch {
    // If the check fails, attempt the add and rely on the duplicate catch below.
  }

  const kept = specs.filter((_, i) => allowed[i]);
  if (kept.length === 0) {
    return { added: 0, skipped: duplicates, failed: 0, noteIds: [], addedCards: [] };
  }

  let results: (number | null)[];
  try {
    results = await ankiRequest<(number | null)[]>(
      endpoint,
      "addNotes",
      { notes: kept.map((spec) => ({ ...spec.note, options: { allowDuplicate: false, duplicateScope: "deck" } })) },
      timeoutMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate/i.test(message)) {
      return { added: 0, skipped: duplicates + kept.length, failed: 0, noteIds: [], addedCards: [] };
    }
    throw error;
  }

  const noteIds: number[] = [];
  const addedCards: AddedCardRef[] = [];
  let added = 0;
  let skipped = duplicates;
  const failed = 0;
  results.forEach((id, i) => {
    if (typeof id === "number") {
      added += 1;
      noteIds.push(id);
      addedCards.push({ index: kept[i].index, noteId: id });
    } else {
      skipped += 1;
    }
  });
  return { added, skipped, failed, noteIds, addedCards };
}

/** Simple add without card-index tracking. */
export async function addNoteSpecs(endpoint: string, notes: NoteSpec[], timeoutMs = 30_000): Promise<AddResult> {
  const result = await addIndexed(
    endpoint,
    notes.map((note, index) => ({ note, index })),
    timeoutMs,
  );
  return { added: result.added, skipped: result.skipped, failed: result.failed, noteIds: result.noteIds };
}

/** Build (storing media as needed) and add a mixed batch of cloze and image cards. */
export async function addCards(
  endpoint: string,
  cards: FinalCard[],
  settings: Settings,
  url: string,
): Promise<AddCardsResult> {
  if (cards.length === 0) return { added: 0, skipped: 0, failed: 0, noteIds: [], addedCards: [] };
  const specs: IndexedSpec[] = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const note =
      card.kind === "image"
        ? await imageNote(endpoint, card, settings, url)
        : clozeNote(card, settings.anki, url, settings.triggers.allowContextInBackExtra);
    specs.push({ note, index });
  }
  return addIndexed(endpoint, specs);
}

export function generateCardsFromLlm(cards: GeneratedCard[]): FinalCard[] {
  return cards.map((card) => ({
    kind: card.kind,
    text: card.text,
    backExtra: card.backExtra,
    deck: "",
    image: card.image,
    imageSide: card.imageSide,
    bothDirections: card.bothDirections,
  }));
}

export async function deleteNotes(endpoint: string, noteIds: number[]): Promise<void> {
  if (noteIds.length === 0) return;
  await ankiRequest(endpoint, "deleteNotes", { notes: noteIds });
}

export async function notesInfo(endpoint: string, noteIds: number[]): Promise<AnkiNoteInfo[]> {
  if (noteIds.length === 0) return [];
  const raw = await ankiRequest<Record<string, unknown>[]>(endpoint, "notesInfo", { notes: noteIds });
  // AnkiConnect returns an empty object for missing notes; drop those so callers
  // can detect orphans by comparing requested ids against returned ones.
  return raw
    .filter((note) => typeof note?.noteId === "number")
    .map((note) => {
      const fields = (note.fields as Record<string, { value?: string }>) ?? {};
      return {
        noteId: note.noteId as number,
        modelName: (note.modelName as string) ?? "",
        fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v?.value ?? ""])),
        cards: (note.cards as number[]) ?? [],
      };
    });
}

export async function updateNoteFields(
  endpoint: string,
  noteId: number,
  fields: Record<string, string>,
): Promise<void> {
  await ankiRequest(endpoint, "updateNoteFields", { note: { id: noteId, fields } });
}

export async function findNotes(endpoint: string, query: string): Promise<number[]> {
  return ankiRequest<number[]>(endpoint, "findNotes", { query });
}
