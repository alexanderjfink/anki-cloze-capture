import { keys, getRaw, setRaw } from "./storage";
import type { HypothesisAnnotation, PageAnchor } from "./types";

const API = "https://api.hypothes.is/api";

interface HypSelector {
  type: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
}

interface HypTarget {
  source?: string;
  selector?: HypSelector[];
}

export interface HypApiAnnotation {
  id?: string;
  uri?: string;
  text?: string;
  tags?: string[];
  group?: string;
  created?: string;
  updated?: string;
  user?: string;
  target?: HypTarget[];
}

/** Map an annotation's TextQuoteSelector onto our page anchor format. */
export function selectorToAnchor(annotation: HypApiAnnotation): PageAnchor | null {
  const selector = annotation.target?.[0]?.selector?.find((s) => s.type === "TextQuoteSelector");
  if (!selector?.exact) return null;
  return {
    kind: "text",
    quote: selector.exact,
    prefix: selector.prefix ?? "",
    suffix: selector.suffix ?? "",
  };
}

function toAnnotation(annotation: HypApiAnnotation): HypothesisAnnotation | null {
  const anchor = selectorToAnchor(annotation);
  if (!anchor || !annotation.id) return null;
  return {
    id: annotation.id,
    exact: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    noteText: (annotation.text ?? "").trim(),
    url: annotation.uri ?? "",
    created: annotation.created ?? "",
  };
}

/** Parse a Hypothes.is search response into highlights (drops page notes). Pure/testable. */
export function parseAnnotations(response: unknown): HypothesisAnnotation[] {
  const rows = (response as { rows?: HypApiAnnotation[] })?.rows ?? [];
  return rows.map(toAnnotation).filter((a): a is HypothesisAnnotation => a !== null);
}

/** Stable content key used to dedupe across API and DOM detection. */
export function contentKey(urlKey: string, anchor: PageAnchor): string {
  const input = `${urlKey}|${anchor.quote}|${anchor.prefix}|${anchor.suffix}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export async function getProfile(token: string): Promise<{ ok: boolean; userid?: string; error?: string }> {
  try {
    const response = await fetch(`${API}/profile`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, error: response.status === 401 ? "Token rejected (401)" : `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { userid?: string };
    return { ok: true, userid: data.userid };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchAnnotations(
  token: string,
  pageUrl: string,
  userId?: string,
): Promise<{ ok: boolean; annotations: HypothesisAnnotation[]; error?: string }> {
  try {
    const params = new URLSearchParams({ uri: pageUrl, limit: "200", sort: "created", order: "asc" });
    if (userId) params.set("user", userId);
    const response = await fetch(`${API}/search?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) {
      return {
        ok: false,
        annotations: [],
        error: response.status === 401 ? "Hypothes.is token rejected (401)" : `HTTP ${response.status}`,
      };
    }
    const data = await response.json();
    return { ok: true, annotations: parseAnnotations(data) };
  } catch (error) {
    return { ok: false, annotations: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// --- processed-highlight history ---

export interface HypSeen {
  initialized: boolean;
  ids: string[];
}

type SeenStore = Record<string, HypSeen>;

export async function getSeen(urlKey: string): Promise<HypSeen> {
  const store = (await getRaw<SeenStore>(keys.HYPOTHESIS_SEEN_KEY)) ?? {};
  return store[urlKey] ?? { initialized: false, ids: [] };
}

export async function setSeen(urlKey: string, seen: HypSeen): Promise<void> {
  const store = (await getRaw<SeenStore>(keys.HYPOTHESIS_SEEN_KEY)) ?? {};
  store[urlKey] = { initialized: seen.initialized, ids: seen.ids.slice(-2000) };
  await setRaw(keys.HYPOTHESIS_SEEN_KEY, store);
}

export async function clearSeen(): Promise<void> {
  await setRaw(keys.HYPOTHESIS_SEEN_KEY, {});
}
