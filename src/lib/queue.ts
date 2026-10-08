import { addCards, deleteNotes, ankiVersion } from "./anki";
import { keys, getRaw, setRaw } from "./storage";
import type { FinalCard, PageAnchor, QueueItem, RecentBatch, Settings } from "./types";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listQueue(): Promise<QueueItem[]> {
  return (await getRaw<QueueItem[]>(keys.QUEUE_KEY)) ?? [];
}

export async function enqueue(
  cards: FinalCard[],
  url: string,
  anchor?: PageAnchor,
  title?: string,
): Promise<QueueItem> {
  const item: QueueItem = { id: newId(), createdAt: Date.now(), cards, url, title, anchor };
  const queue = await listQueue();
  queue.push(item);
  await setRaw(keys.QUEUE_KEY, queue);
  return item;
}

export async function clearQueue(): Promise<void> {
  await setRaw(keys.QUEUE_KEY, []);
}

export async function removeQueueItem(id: string): Promise<void> {
  const queue = await listQueue();
  await setRaw(
    keys.QUEUE_KEY,
    queue.filter((item) => item.id !== id),
  );
}

export interface FlushResult {
  flushed: number;
  remaining: number;
  added: number;
  skipped: number;
  online: boolean;
  error?: string;
}

/**
 * Try to add every queued item. Items that succeed are removed; the queue
 * persists if AnkiConnect is unavailable. Best-effort on partial failures.
 */
export async function flushQueue(
  settings: Settings,
  onFlushed?: (item: QueueItem, noteIds: number[]) => void | Promise<void>,
): Promise<FlushResult> {
  const queue = await listQueue();
  if (queue.length === 0) {
    return { flushed: 0, remaining: 0, added: 0, skipped: 0, online: true };
  }

  try {
    await ankiVersion(settings.anki.endpoint);
  } catch (error) {
    return {
      flushed: 0,
      remaining: queue.length,
      added: 0,
      skipped: 0,
      online: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const remaining: QueueItem[] = [];
  let flushed = 0;
  let added = 0;
  let skipped = 0;

  for (const item of queue) {
    try {
      const result = await addCards(settings.anki.endpoint, item.cards, settings, item.url);
      added += result.added;
      skipped += result.skipped;
      flushed += 1;
      if (onFlushed) await onFlushed(item, result.noteIds);
    } catch {
      remaining.push(item);
    }
  }

  await setRaw(keys.QUEUE_KEY, remaining);
  return { flushed, remaining: remaining.length, added, skipped, online: true };
}

// --- Recent batches (for Undo) ---

export async function listRecent(): Promise<RecentBatch[]> {
  return (await getRaw<RecentBatch[]>(keys.RECENT_KEY)) ?? [];
}

export async function addRecent(batch: RecentBatch): Promise<void> {
  const recent = await listRecent();
  recent.unshift(batch);
  await setRaw(keys.RECENT_KEY, recent.slice(0, 25));
}

export async function undoRecent(settings: Settings, batchId: string): Promise<number> {
  const recent = await listRecent();
  const batch = recent.find((b) => b.id === batchId);
  if (!batch) return 0;
  await deleteNotes(settings.anki.endpoint, batch.noteIds);
  await setRaw(
    keys.RECENT_KEY,
    recent.filter((b) => b.id !== batchId),
  );
  return batch.noteIds.length;
}
