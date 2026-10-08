import type { PageAnchor } from "./types";

export interface AnchorMatch {
  index: number;
  length: number;
  score: number;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

/** True when the match neither starts nor ends in the middle of a word. */
function atWordBoundaries(full: string, index: number, length: number): boolean {
  const first = full[index];
  const last = full[index + length - 1];
  const before = index > 0 ? full[index - 1] : undefined;
  const after = full[index + length];
  const leftOk = !isWordChar(first) || !isWordChar(before);
  const rightOk = !isWordChar(last) || !isWordChar(after);
  return leftOk && rightOk;
}

/** Whole-word (and start/end-of-text) aware `includes`. */
function includesWhole(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;
    if (atWordBoundaries(haystack, index, needle.length)) return true;
    from = index + 1;
  }
  return false;
}

/** Match the quote in the page text, tolerating whitespace differences. */
function quotePattern(quote: string): RegExp {
  const collapsed = quote.trim().replace(/\s+/g, " ");
  return new RegExp(escapeRegex(collapsed).replace(/ /g, "\\s+"), "g");
}

/**
 * Find the best occurrence of `quote` in `full`, scored by how well the
 * surrounding prefix/suffix text matches. Pure and unit-testable.
 */
export function findBestMatch(
  full: string,
  quote: string,
  prefix: string,
  suffix: string,
  maxCandidates = 60,
): AnchorMatch | null {
  if (!quote.trim()) return null;
  const regex = quotePattern(quote);
  let best: AnchorMatch | null = null;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = regex.exec(full)) !== null && count < maxCandidates) {
    const index = match.index;
    const length = match[0].length;
    if (!atWordBoundaries(full, index, length)) {
      if (regex.lastIndex === match.index) regex.lastIndex += 1;
      count += 1;
      continue;
    }
    const before = full.slice(Math.max(0, index - prefix.length), index);
    const after = full.slice(index + length, index + length + suffix.length);
    let score = 0;
    for (let k = 1; k <= Math.min(prefix.length, before.length); k += 1) {
      if (prefix[prefix.length - k] === before[before.length - k]) score += 1;
      else break;
    }
    for (let k = 0; k < Math.min(suffix.length, after.length); k += 1) {
      if (suffix[k] === after[k]) score += 1;
      else break;
    }
    if (!best || score > best.score) best = { index, length, score };
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
    count += 1;
  }
  return best;
}

// --- DOM helpers (content script only) ---

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);

export function cssPath(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(" > ");
}

interface TextChunk {
  node: Text;
  start: number;
  end: number;
}

function collectTextChunks(root: ParentNode): { full: string; chunks: TextChunk[] } {
  const chunks: TextChunk[] = [];
  let full = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".acc-mark, .acc-marker-host")) return NodeFilter.FILTER_REJECT;
      return (node as Text).data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    chunks.push({ node: text, start: full.length, end: full.length + text.data.length });
    full += text.data;
    node = walker.nextNode();
  }
  return { full, chunks };
}

function rangeFromIndices(chunks: TextChunk[], start: number, end: number): Range | null {
  const startChunk = chunks.find((c) => start >= c.start && start < c.end);
  const endChunk = chunks.find((c) => end > c.start && end <= c.end) ?? startChunk;
  if (!startChunk || !endChunk) return null;
  const range = document.createRange();
  try {
    range.setStart(startChunk.node, start - startChunk.start);
    range.setEnd(endChunk.node, end - endChunk.start);
  } catch {
    return null;
  }
  return range;
}

export interface LocatedAnchor {
  range?: Range;
  element?: Element;
  score: number;
}

/** Locate an anchor in the current document. */
export function locateAnchor(anchor: PageAnchor, root: ParentNode = document.body): LocatedAnchor | null {
  if (anchor.kind === "image") {
    let element: Element | null = null;
    if (anchor.imageSrc) {
      element = Array.from(document.images).find(
        (img) => img.currentSrc === anchor.imageSrc || img.src === anchor.imageSrc,
      ) ?? null;
    }
    if (!element && anchor.path) {
      try {
        element = root.querySelector(anchor.path);
      } catch {
        element = null;
      }
    }
    return element ? { element, score: 1 } : null;
  }

  // Prefer the path hint when the quote is still inside it.
  if (anchor.path) {
    try {
      const el = root.querySelector(anchor.path);
      if (el) {
        const { full, chunks } = collectTextChunks(el);
        const match = findBestMatch(full, anchor.quote, anchor.prefix, anchor.suffix);
        if (match) {
          const range = rangeFromIndices(chunks, match.index, match.index + match.length);
          if (range) return { range, score: match.score + 2 };
        }
      }
    } catch {
      // fall through to whole-document search
    }
  }

  const { full, chunks } = collectTextChunks(root ?? document.body);
  const match = findBestMatch(full, anchor.quote, anchor.prefix, anchor.suffix);
  if (!match) return null;
  const range = rangeFromIndices(chunks, match.index, match.index + match.length);
  return range ? { range, score: match.score } : null;
}

/** Build a text anchor from a selection range. */
export function anchorFromRange(range: Range): PageAnchor {
  const quote = range.toString().replace(/\s+/g, " ").trim();
  let prefix = "";
  let suffix = "";
  const start = range.startContainer;
  const end = range.endContainer;
  if (start.nodeType === Node.TEXT_NODE) {
    prefix = (start as Text).data.slice(Math.max(0, range.startOffset - 40), range.startOffset);
  }
  if (end.nodeType === Node.TEXT_NODE) {
    suffix = (end as Text).data.slice(range.endOffset, range.endOffset + 40);
  }
  const element =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  return {
    kind: "text",
    quote,
    prefix: prefix.replace(/\s+/g, " "),
    suffix: suffix.replace(/\s+/g, " "),
    path: element ? cssPath(element) : undefined,
    offset: range.startOffset,
  };
}

export function anchorFromImage(img: HTMLImageElement): PageAnchor {
  return {
    kind: "image",
    quote: img.alt || "",
    prefix: "",
    suffix: "",
    path: cssPath(img),
    imageSrc: img.currentSrc || img.src,
  };
}

/** The full visible text of a root (used for locating/anchoring). */
export function getPageText(root: ParentNode = document.body): string {
  return collectTextChunks(root).full;
}

/**
 * Find a verbatim snippet of `sentence` that appears on the page. Tries the whole
 * sentence first, then progressively shorter contiguous word windows. This makes
 * generated cards (which may be rephrased) anchorable. Pure and unit-testable.
 */
export function fuzzyQuote(pageText: string, sentence: string, minWords = 5): string | null {
  const normalized = sentence.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0) return null;
  const haystack = pageText.replace(/\s+/g, " ");
  if (includesWhole(haystack, normalized)) return normalized;
  const maxLen = Math.min(14, words.length);
  for (let len = maxLen; len >= minWords; len -= 1) {
    for (let start = 0; start + len <= words.length; start += 1) {
      const candidate = words.slice(start, start + len).join(" ");
      if (includesWhole(haystack, candidate)) return candidate;
    }
  }
  return null;
}
