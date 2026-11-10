import { describe, expect, it } from "vitest";
import { OpenRouterTts, type FetchLike } from "../../../src/server/tts/openrouterTts.js";
import { TtsProviderError, type TtsRequest } from "../../../src/server/tts/TtsClient.js";

const API_KEY = "sk-or-v1-test-secret-0123456789";
const req: TtsRequest = { model: "openai/gpt-4o-mini-tts-2025-12-15", input: "Boo.", voice: "onyx", response_format: "mp3" };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetch, calls };
}

describe("OpenRouterTts", () => {
  it("posts the request to {baseUrl}/audio/speech and returns the raw bytes as audio/mpeg", async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x44]);
    const { fetch, calls } = fakeFetch(() => new Response(bytes, { status: 200 }));
    const tts = new OpenRouterTts({ apiKey: API_KEY, baseUrl: "https://openrouter.ai/api/v1/", fetch });
    const signal = new AbortController().signal;

    const result = await tts.synthesize(req, signal);

    expect(result.mimeType).toBe("audio/mpeg");
    expect([...result.audio]).toEqual([...bytes]);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Haunted Homelab",
    });
    expect(JSON.parse(init.body as string)).toEqual(req);
  });

  it("maps a non-200 JSON error to TtsProviderError with the message and status", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ error: { code: 400, message: `Invalid voice for key ${API_KEY}` } }, { status: 400 }),
    );
    const tts = new OpenRouterTts({ apiKey: API_KEY, baseUrl: "https://openrouter.ai/api/v1", fetch });
    const err = await tts.synthesize(req, new AbortController().signal).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TtsProviderError);
    expect((err as TtsProviderError).status).toBe(400);
    expect((err as Error).message).toContain("Invalid voice");
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it("maps a non-JSON error body and network failures to TtsProviderError", async () => {
    const html = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err1 = await new OpenRouterTts({ apiKey: API_KEY, baseUrl: "https://x/api/v1", fetch: html.fetch })
      .synthesize(req, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(TtsProviderError);
    expect((err1 as Error).message).toBe("OpenRouter TTS request failed with HTTP 502");

    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    const err2 = await new OpenRouterTts({ apiKey: API_KEY, baseUrl: "https://x/api/v1", fetch: down.fetch })
      .synthesize(req, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(TtsProviderError);
    expect((err2 as Error).message).toContain("fetch failed");
  });

  it("rejects an empty 200 body", async () => {
    const { fetch } = fakeFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    const tts = new OpenRouterTts({ apiKey: API_KEY, baseUrl: "https://x/api/v1", fetch });
    await expect(tts.synthesize(req, new AbortController().signal)).rejects.toBeInstanceOf(TtsProviderError);
  });
});
