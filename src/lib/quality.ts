import type { GeneratedCard } from "./types";

export interface ClozePart {
  num: number;
  answer: string;
  hint?: string;
}

export interface ValidatedCard extends GeneratedCard {
  issues: string[];
}

export interface ParseResult {
  cards: ValidatedCard[];
  error?: string;
}

/** Extract cloze deletions, supporting hints: {{c1::answer::hint}}. */
export function extractClozes(text: string): ClozePart[] {
  const parts: ClozePart[] = [];
  const regex = /\{\{c(\d+)::([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const inner = match[2];
    const segments = inner.split("::");
    const answer = segments[0].trim();
    const hint = segments.length > 1 ? segments.slice(1).join("::").trim() : undefined;
    parts.push({ num: Number(match[1]), answer, hint: hint || undefined });
  }
  return parts;
}

function textOutsideClozes(text: string): string {
  return text.replace(/\{\{c\d+::[\s\S]*?\}\}/g, " ").toLowerCase();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function validateCard(card: GeneratedCard, maxClozeWords: number): string[] {
  const issues: string[] = [];
  const text = (card.text ?? "").trim();
  if (!text) {
    return ["Card text is empty"];
  }

  const clozes = extractClozes(text);
  if (clozes.length === 0) {
    issues.push("No cloze deletion found");
    return issues;
  }
  if (clozes.length > 3) {
    issues.push(`${clozes.length} clozes — split into multiple cards`);
  }

  const outside = textOutsideClozes(text);
  for (const cloze of clozes) {
    if (!cloze.answer) {
      issues.push(`c${cloze.num} has an empty answer`);
      continue;
    }
    const words = wordCount(cloze.answer);
    if (words > maxClozeWords) {
      issues.push(`c${cloze.num} hides ${words} words (max ${maxClozeWords})`);
    }
    const normalized = cloze.answer.toLowerCase();
    if (normalized.length > 2 && outside.includes(normalized)) {
      issues.push(`c${cloze.num} answer appears elsewhere in the text (giveaway)`);
    }
  }
  return issues;
}

/** Pull a JSON object out of a model response that may be wrapped in fences or prose. */
export function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function parseCardResponse(raw: string, maxClozeWords: number): ParseResult {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (error) {
    return { cards: [], error: error instanceof Error ? error.message : String(error) };
  }

  const container = parsed as { cards?: unknown };
  const list = Array.isArray(container?.cards)
    ? container.cards
    : Array.isArray(parsed)
      ? parsed
      : [];

  if (list.length === 0) {
    return { cards: [], error: "The model returned no cards" };
  }

  const cards: ValidatedCard[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    const backExtra = typeof record.backExtra === "string" ? record.backExtra : "";
    const sourceQuote = typeof record.source === "string" ? record.source.trim() : "";
    if (!text.trim()) continue;
    const card: GeneratedCard = { text: text.trim(), backExtra: backExtra.trim(), sourceQuote: sourceQuote || undefined };
    cards.push({ ...card, issues: validateCard(card, maxClozeWords) });
  }

  if (cards.length === 0) {
    return { cards: [], error: "The model did not return any usable cards" };
  }
  return { cards };
}
