import { keys, getRaw, setRaw } from "./storage";
import type { Annotation } from "./types";

export type AnnotationStore = Record<string, Annotation[]>;

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|dclid$|mc_|igshid$|ref_?$|si$|spm$)/i;

/** Normalize a page URL for matching (optionally stripping hash + tracking params). */
export function normalizeUrl(raw: string, normalized = true): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (normalized) {
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}

async function readStore(): Promise<AnnotationStore> {
  return (await getRaw<AnnotationStore>(keys.ANNOTATIONS_KEY)) ?? {};
}

async function writeStore(store: AnnotationStore): Promise<void> {
  await setRaw(keys.ANNOTATIONS_KEY, store);
}

export async function listAnnotations(url: string, normalized = true): Promise<Annotation[]> {
  const store = await readStore();
  return store[normalizeUrl(url, normalized)] ?? [];
}

export async function addAnnotation(annotation: Annotation): Promise<void> {
  const store = await readStore();
  const existing = store[annotation.urlKey] ?? [];
  // Replace any entry with the same id, otherwise append.
  const next = existing.filter((a) => a.id !== annotation.id);
  next.push(annotation);
  store[annotation.urlKey] = next.slice(-300);
  await writeStore(store);
}

export async function removeAnnotation(url: string, id: string, normalized = true): Promise<void> {
  const store = await readStore();
  const key = normalizeUrl(url, normalized);
  const existing = store[key];
  if (!existing) return;
  const next = existing.filter((a) => a.id !== id);
  if (next.length === 0) delete store[key];
  else store[key] = next;
  await writeStore(store);
}

export async function countForUrl(url: string, normalized = true): Promise<number> {
  return (await listAnnotations(url, normalized)).length;
}
