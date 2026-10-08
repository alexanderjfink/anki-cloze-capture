import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chat, describeHttpError } from "../src/lib/llm";
import { embedTexts } from "../src/lib/embeddings";
import { buildMessages } from "../src/lib/prompt";
import { parseCardResponse } from "../src/lib/quality";
import { mergeSettings } from "../src/lib/storage";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/chat/completions")) {
        const body = (await request.json()) as { model?: string; messages?: { content?: string }[] };
        if (body.model === "echo-model") {
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    model: body.model,
                    auth: request.headers.get("authorization") ?? null,
                  }),
                },
              },
            ],
          });
        }
        const userText = body.messages?.map((m) => m.content).join(" ") ?? "";
        if (!userText.includes("mock selection")) {
          return Response.json({ choices: [{ message: { content: "{}" } }] });
        }
        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"cards":[{"text":"The Olmec carved {{c1::stone heads::monuments}} from {{c2::basalt}}.","backExtra":"Early Mesoamerican civilization."}]}',
              },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/api/embed")) {
        const body = (await request.json()) as { input?: string[] | string };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return Response.json({ embeddings: Array.from({ length: count }, () => [0.1, 0.2, 0.3]) });
      }
      if (url.pathname.endsWith("/embeddings")) {
        const body = (await request.json()) as { input?: string[] | string };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return Response.json({ data: Array.from({ length: count }, () => ({ embedding: [0.4, 0.5, 0.6] })) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe("chat pipeline", () => {
  test("generates and parses cloze cards through an OpenAI-compatible provider", async () => {
    const settings = mergeSettings({
      activeProvider: "vllm",
      providers: { vllm: { baseUrl: `${base}/v1`, model: "mock-model", apiKey: "" } },
    });
    const raw = await chat(settings, buildMessages(settings, {
      selection: "The mock selection about the Olmec.",
      context: "Some surrounding context.",
      title: "Test",
      url: "https://example.com",
    }));
    const parsed = parseCardResponse(raw, 2);
    expect(parsed.error).toBeUndefined();
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0].text).toContain("{{c1::stone heads::monuments}}");
    expect(parsed.cards[0].issues).toEqual([]);
  });

  test("sends the selection verbatim to the provider", async () => {
    const settings = mergeSettings({
      activeProvider: "vllm",
      providers: { vllm: { baseUrl: `${base}/v1`, model: "mock-model", apiKey: "" } },
    });
    const raw = await chat(settings, buildMessages(settings, {
      selection: "the mock selection",
      context: "",
      title: "",
      url: "",
    }));
    expect(raw).toContain("cards");
  });

  test("providerKind override selects that provider's base URL, model, and key", async () => {
    const settings = mergeSettings({
      activeProvider: "opencode-go",
      providers: {
        "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", model: "remote-model", apiKey: "remote-key" },
        ollama: { baseUrl: `${base}/v1`, model: "echo-model", apiKey: "local-key" },
      },
    });
    const raw = await chat(settings, [{ role: "user", content: "hi" }], { providerKind: "ollama" });
    const echoed = JSON.parse(raw) as { model: string; auth: string | null };
    expect(echoed.model).toBe("echo-model");
    expect(echoed.auth).toBe("Bearer local-key");
  });
});

describe("http error reporting", () => {
  test("surfaces the server message and an auth hint on 401", async () => {
    const response = new Response(JSON.stringify({ error: { message: "API key required" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const message = await describeHttpError(response);
    expect(message).toContain("401");
    expect(message).toContain("API key required");
    expect(message).toContain("check the API key");
  });
});

describe("embedding pipeline", () => {
  test("uses the Ollama native /api/embed endpoint", async () => {
    const settings = mergeSettings({ embeddings: { kind: "ollama", baseUrl: base, model: "nomic", apiKey: "" } });
    const vectors = await embedTexts(settings.embeddings, ["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0.1, 0.2, 0.3]);
  });

  test("uses the OpenAI-compatible /v1/embeddings endpoint for vLLM", async () => {
    const settings = mergeSettings({ embeddings: { kind: "vllm", baseUrl: `${base}/v1`, model: "embed", apiKey: "" } });
    const vectors = await embedTexts(settings.embeddings, ["a"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toEqual([0.4, 0.5, 0.6]);
  });
});
