import type { EmbeddingConfig } from "./types";
import { LlmError, describeHttpError, modelsUrl } from "./llm";

export interface EmbeddingListResult {
  ok: boolean;
  models: string[];
  error?: string;
}

function root(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function openAiEmbeddingsUrl(baseUrl: string): string {
  const base = root(baseUrl);
  if (/\/embeddings$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

function ollamaRoot(baseUrl: string): string {
  const base = root(baseUrl);
  return base.replace(/\/v\d+$/, "");
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmError(`Embedding error ${response.status}: ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LlmError(`Embedding request to ${url} timed out`);
    }
    throw new LlmError(`Cannot reach embedding endpoint at ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

async function embedOpenAi(config: EmbeddingConfig, texts: string[], timeoutMs: number): Promise<number[][]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const data = await fetchJson<{ data?: { embedding?: number[] }[] }>(
    openAiEmbeddingsUrl(config.baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, input: texts }),
    },
    timeoutMs,
  );
  const vectors = (data.data ?? []).map((d) => d.embedding ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
    throw new LlmError("Embedding endpoint returned malformed vectors");
  }
  return vectors;
}

async function embedOllama(config: EmbeddingConfig, texts: string[], timeoutMs: number): Promise<number[][]> {
  // Newer Ollama: /api/embed supports the input array directly.
  try {
    const data = await fetchJson<{ embeddings?: number[][] }>(
      `${ollamaRoot(config.baseUrl)}/api/embed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, input: texts }),
      },
      timeoutMs,
    );
    if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
      return data.embeddings;
    }
  } catch {
    // fall through to alternatives
  }

  // Fallback: OpenAI-compatible endpoint on the same Ollama server.
  try {
    return await embedOpenAi(config, texts, timeoutMs);
  } catch {
    // Fallback: legacy one-at-a-time endpoint.
  }

  const vectors: number[][] = [];
  for (const prompt of texts) {
    const data = await fetchJson<{ embedding?: number[] }>(
      `${ollamaRoot(config.baseUrl)}/api/embeddings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, prompt }),
      },
      timeoutMs,
    );
    if (!data.embedding || data.embedding.length === 0) {
      throw new LlmError("Ollama returned an empty embedding");
    }
    vectors.push(data.embedding);
  }
  return vectors;
}

export async function embedTexts(
  config: EmbeddingConfig,
  texts: string[],
  timeoutMs = 30_000,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!config.model) throw new LlmError("No embedding model configured");
  if (config.kind === "ollama") return embedOllama(config, texts, timeoutMs);
  return embedOpenAi(config, texts, timeoutMs);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function testEmbeddings(config: EmbeddingConfig, timeoutMs = 8000): Promise<EmbeddingListResult> {
  try {
    const vectors = await embedTexts(config, ["embedding connectivity test"], timeoutMs);
    if (vectors[0]?.length) return { ok: true, models: [`dimension ${vectors[0].length}`] };
    return { ok: false, models: [], error: "No vector returned" };
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** List models from an OpenAI-compatible /models endpoint (used by options UI). */
export async function listEmbeddingModels(config: { baseUrl: string; apiKey: string }): Promise<EmbeddingListResult> {
  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(modelsUrl(config.baseUrl), { headers });
    if (!response.ok) return { ok: false, models: [], error: await describeHttpError(response) };
    const data = (await response.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    return { ok: true, models };
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}
