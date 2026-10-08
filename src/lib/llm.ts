import type { ChatProviderConfig, ChatProviderKind, ReasoningEffort, Settings } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Stable per-conversation routing id. Auto-generated for OpenCode Go if omitted. */
  sessionId?: string;
  /** Override the configured reasoning effort (only sent to OpenCode Go). */
  reasoningEffort?: ReasoningEffort;
  /** Override which provider to call (used by the provider strategy). */
  providerKind?: ChatProviderKind;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/** True when the endpoint is the OpenCode Go managed inference gateway. */
export function isOpenCodeGo(baseUrl: string): boolean {
  return /opencode\.ai/i.test(baseUrl);
}

/** Opaque session id in the shape the official tooling uses: ses_ + 32 hex chars. */
export function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ses_${hex}`;
}

/** Turn a failed HTTP response into a message that includes the server's own reason. */
export async function describeHttpError(response: Response): Promise<string> {
  let detail = "";
  try {
    const clone = response.clone();
    const body = (await clone.json()) as { error?: unknown; message?: unknown };
    const raw = body?.error ?? body?.message ?? "";
    detail = typeof raw === "string" ? raw : (raw as { message?: string })?.message ?? JSON.stringify(raw);
  } catch {
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = "";
    }
  }
  const authHint = response.status === 401 || response.status === 403 ? " (check the API key in Settings)" : "";
  return `HTTP ${response.status}${detail ? `: ${detail}` : ""}${authHint}`;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Resolve a chat-completions URL from a possibly incomplete base URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (/\/models$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

function headers(config: ChatProviderConfig, sessionId?: string): Record<string, string> {
  const out: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) out.Authorization = `Bearer ${config.apiKey}`;
  if (isOpenCodeGo(config.baseUrl)) {
    // OpenCode Go rejects requests without a stable routing/session header.
    out["x-opencode-session"] = sessionId ?? newSessionId();
  }
  return out;
}

export function resolveProvider(
  settings: Settings,
  kind?: ChatProviderKind,
): { kind: ChatProviderKind; config: ChatProviderConfig } {
  const resolved = kind ?? settings.activeProvider;
  return { kind: resolved, config: settings.providers[resolved] };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LlmError(`Request to ${url} timed out`);
    }
    throw new LlmError(`Cannot reach LLM endpoint at ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(
  settings: Settings,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const { config } = resolveProvider(settings, options.providerKind);
  if (!config.model) throw new LlmError("No model configured for the active provider");
  if (!config.baseUrl) throw new LlmError("No base URL configured for the active provider");

  const effort = options.reasoningEffort ?? settings.cards.reasoningEffort;
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: options.temperature ?? settings.cards.temperature,
    max_tokens: options.maxTokens ?? 2000,
    stream: false,
  };
  // Reasoning control is an OpenCode Go extension; other providers reject it.
  if (isOpenCodeGo(config.baseUrl) && effort && effort !== "default") {
    body.reasoning_effort = effort;
  }

  const response = await fetchWithTimeout(
    chatCompletionsUrl(config.baseUrl),
    { method: "POST", headers: headers(config, options.sessionId), body: JSON.stringify(body) },
    options.timeoutMs ?? 120_000,
  );

  if (!response.ok) {
    throw new LlmError(`LLM error ${await describeHttpError(response)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim()) return content;

  // Reasoning models can exhaust the token budget on reasoning before producing
  // any content; give an actionable error instead of a bare "empty response".
  const usedReasoning = Boolean(choice?.message?.reasoning_content);
  if (choice?.finish_reason === "length" || usedReasoning) {
    throw new LlmError(
      "The model ran out of tokens while reasoning. Increase max cards, or set reasoning effort to \"none\" in Settings.",
    );
  }
  throw new LlmError("LLM returned an empty response");
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** Ask a vision-capable model to name/describe an image (OpenAI-style content parts). */
export async function chatVision(
  settings: Settings,
  prompt: string,
  dataUrl: string,
  options: ChatOptions = {},
): Promise<string> {
  const { config } = resolveProvider(settings, options.providerKind);
  if (!config.model) throw new LlmError("No model configured for the active provider");
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 200,
    stream: false,
  };
  const effort = options.reasoningEffort ?? settings.cards.reasoningEffort;
  if (isOpenCodeGo(config.baseUrl) && effort && effort !== "default") body.reasoning_effort = effort;

  const response = await fetchWithTimeout(
    chatCompletionsUrl(config.baseUrl),
    { method: "POST", headers: headers(config, options.sessionId), body: JSON.stringify(body) },
    options.timeoutMs ?? 60_000,
  );
  if (!response.ok) throw new LlmError(`Vision error ${await describeHttpError(response)}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new LlmError("Vision model returned an empty response");
  return content;
}

export async function listModels(
  config: { baseUrl: string; apiKey: string },
  timeoutMs = 8000,
): Promise<ModelListResult> {
  try {
    const response = await fetchWithTimeout(
      modelsUrl(config.baseUrl),
      { method: "GET", headers: headers({ ...config, model: "" }) },
      timeoutMs,
    );    if (!response.ok) {
      return { ok: false, models: [], error: await describeHttpError(response) };
    }
    const data = (await response.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return { ok: true, models };
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}
