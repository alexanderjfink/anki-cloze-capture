import { cosineSimilarity, embedTexts } from "./embeddings";
import { chat } from "./llm";
import { keys, getRaw, setRaw } from "./storage";
import type { DeckMatch, Settings } from "./types";

interface DeckIndex {
  key: string;
  decks: string[];
  vectors: number[][];
  model: string;
}

export interface RouteResult {
  match: DeckMatch;
  source: "embedding" | "llm" | "fallback";
  indexSize: number;
  warning?: string;
}

function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** Decks excluded from routing: always Default, plus the user's list. */
export function candidateDecks(settings: Settings, decks: string[]): string[] {
  const excluded = new Set(["Default", ...settings.routing.exclusions]);
  return decks.filter((deck) => !excluded.has(deck));
}

function deckEmbeddingText(settings: Settings, deck: string): string {
  const description = settings.routing.deckDescriptions[deck]?.trim();
  const readable = deck.replace(/::/g, " > ");
  return description ? `${readable}: ${description}` : readable;
}

function indexKey(settings: Settings, decks: string[]): string {
  const payload = [
    settings.embeddings.kind,
    settings.embeddings.baseUrl,
    settings.embeddings.model,
    ...decks.map((d) => deckEmbeddingText(settings, d)),
  ].join("|");
  return hash(payload);
}

async function getCachedIndex(settings: Settings, decks: string[]): Promise<DeckIndex | null> {
  const cached = await getRaw<DeckIndex>(keys.INDEX_KEY);
  if (!cached) return null;
  if (cached.key !== indexKey(settings, decks)) return null;
  if (cached.vectors.length !== decks.length) return null;
  return cached;
}

export async function rebuildDeckIndex(settings: Settings, decks: string[]): Promise<DeckIndex> {
  const candidates = candidateDecks(settings, decks);
  const vectors = await embedTexts(
    settings.embeddings,
    candidates.map((deck) => deckEmbeddingText(settings, deck)),
  );
  if (vectors.length !== candidates.length) {
    throw new Error("Embedding count did not match deck count");
  }
  const index: DeckIndex = {
    key: indexKey(settings, candidates),
    decks: candidates,
    vectors,
    model: settings.embeddings.model,
  };
  await setRaw(keys.INDEX_KEY, index);
  return index;
}

async function ensureIndex(settings: Settings, decks: string[]): Promise<DeckIndex> {
  const candidates = candidateDecks(settings, decks);
  const cached = await getCachedIndex(settings, candidates);
  if (cached) return cached;
  return rebuildDeckIndex(settings, decks);
}

async function llmPickDeck(
  settings: Settings,
  deckList: string[],
  text: string,
): Promise<string | null> {
  const prompt = [
    "Choose the single most relevant Anki deck for the passage below.",
    "Reply with only the exact deck name from this list, nothing else:",
    ...deckList.map((d) => `- ${d}`),
    "",
    `Passage: ${text.slice(0, 1200)}`,
  ].join("\n");
  try {
    const answer = await chat(
      settings,
      [
        { role: "system", content: "You route study material to the best-fitting deck." },
        { role: "user", content: prompt },
      ],
      { temperature: 0, maxTokens: 200, timeoutMs: 30_000, reasoningEffort: "none" },
    );
    const trimmed = answer.trim();
    const exact = deckList.find((d) => trimmed === d);
    if (exact) return exact;
    const partial = deckList.find((d) => trimmed.toLowerCase().includes(d.toLowerCase()));
    return partial ?? null;
  } catch {
    return null;
  }
}

/**
 * Route text to the best deck. Order of precedence:
 * embedding similarity -> LLM choice -> configured fallback deck.
 */
export async function routeDeck(
  settings: Settings,
  allDecks: string[],
  text: string,
): Promise<RouteResult> {
  const fallback = settings.routing.fallbackDeck;
  const candidates = candidateDecks(settings, allDecks);
  if (candidates.length === 0) {
    return { match: { deck: fallback, confidence: 0 }, source: "fallback", indexSize: 0 };
  }

  try {
    const index = await ensureIndex(settings, allDecks);
    const [vector] = await embedTexts(settings.embeddings, [text.slice(0, 2000)]);
    let best = -1;
    let bestScore = -1;
    index.vectors.forEach((vec, i) => {
      const score = cosineSimilarity(vector, vec);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0 && bestScore >= settings.routing.threshold) {
      return {
        match: { deck: index.decks[best], confidence: bestScore },
        source: "embedding",
        indexSize: index.decks.length,
      };
    }
    if (best >= 0) {
      // Too uncertain for embeddings; try the LLM before giving up.
      const llmChoice = await llmPickDeck(settings, index.decks, text);
      if (llmChoice) {
        return {
          match: { deck: llmChoice, confidence: Math.max(bestScore, 0) },
          source: "llm",
          indexSize: index.decks.length,
        };
      }
      return {
        match: { deck: fallback, confidence: bestScore },
        source: "fallback",
        indexSize: index.decks.length,
        warning: `Best match "${index.decks[best]}" scored ${bestScore.toFixed(2)}, below threshold ${settings.routing.threshold}.`,
      };
    }
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    const llmChoice = await llmPickDeck(settings, candidates, text);
    if (llmChoice) {
      return { match: { deck: llmChoice, confidence: 0 }, source: "llm", indexSize: candidates.length, warning };
    }
    return { match: { deck: fallback, confidence: 0 }, source: "fallback", indexSize: candidates.length, warning };
  }

  return { match: { deck: fallback, confidence: 0 }, source: "fallback", indexSize: candidates.length };
}
