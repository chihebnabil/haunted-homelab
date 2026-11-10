import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/server/logging/logger.js";
import {
  LlmClient,
  LlmProviderError,
  LlmTimeoutError,
  type LlmProvider,
  type LlmRequest,
} from "../../../src/server/llm/LlmClient.js";
import { OpenRouterLlm } from "../../../src/server/llm/openrouter.js";

const API_KEY = "sk-or-v1-test-secret-0123456789";

function capturingLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: createLogger([API_KEY], sink), lines };
}

const req: LlmRequest = {
  system: "You are a ghost.",
  messages: [{ role: "user", content: "Is plex okay?" }],
  maxTokens: 300,
  json: true,
};

describe("LlmClient", () => {
  it("returns the provider text", async () => {
    const provider: LlmProvider = { complete: async () => "boo" };
    const client = new LlmClient(provider, capturingLogger().logger);
    await expect(client.complete(req, 1000)).resolves.toBe("boo");
  });

  it("times out with LlmTimeoutError and aborts the provider signal, even if the provider hangs", async () => {
    let seen: AbortSignal | undefined;
    const provider: LlmProvider = {
      complete: (_r, signal) => {
        seen = signal;
        return new Promise<string>(() => {}); // never settles, ignores the signal
      },
    };
    const client = new LlmClient(provider, capturingLogger().logger);
    await expect(client.complete(req, 20)).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("rejects immediately when no time remains", async () => {
    let called = false;
    const provider: LlmProvider = { complete: async () => ((called = true), "x") };
    const client = new LlmClient(provider, capturingLogger().logger);
    await expect(client.complete(req, 0)).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(called).toBe(false);
  });

  it("wraps provider failures in LlmProviderError", async () => {
    const provider: LlmProvider = { complete: async () => Promise.reject(new Error("kaput")) };
    const client = new LlmClient(provider, capturingLogger().logger);
    await expect(client.complete(req, 1000)).rejects.toBeInstanceOf(LlmProviderError);
  });
});

describe("OpenRouterLlm", () => {
  type Call = { url: string; headers: Headers; body: Record<string, unknown> };

  function fakeFetch(status: number, payload: unknown, calls: Call[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  const completion = {
    id: "gen-1",
    object: "chat.completion",
    created: 0,
    model: "openai/gpt-4o-mini",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"reply":"boo"}' } }],
  };

  it("posts to {baseUrl}/chat/completions with the model, JSON mode, bearer key, and X-Title", async () => {
    const calls: Call[] = [];
    const llm = new OpenRouterLlm({
      apiKey: API_KEY,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o-mini",
      fetch: fakeFetch(200, completion, calls),
    });
    const text = await llm.complete(req, new AbortController().signal);

    expect(text).toBe('{"reply":"boo"}');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call.headers.get("x-title")).toBe("Haunted Homelab");
    expect(call.body).toMatchObject({
      model: "openai/gpt-4o-mini",
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a ghost." },
        { role: "user", content: "Is plex okay?" },
      ],
    });
  });

  it("omits response_format when json is false", async () => {
    const calls: Call[] = [];
    const llm = new OpenRouterLlm({
      apiKey: API_KEY,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      fetch: fakeFetch(200, completion, calls),
    });
    await llm.complete({ ...req, json: false }, new AbortController().signal);
    expect(calls[0]!.body).not.toHaveProperty("response_format");
  });

  it("maps an OpenRouter error to LlmProviderError once, without retries or the key", async () => {
    const calls: Call[] = [];
    const llm = new OpenRouterLlm({
      apiKey: API_KEY,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      fetch: fakeFetch(500, { error: { message: `upstream failed for ${API_KEY}`, code: 500 } }, calls),
    });
    const err = await llm.complete(req, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).status).toBe(500);
    expect((err as Error).message).not.toContain(API_KEY);
    expect(calls).toHaveLength(1);
  });
});
