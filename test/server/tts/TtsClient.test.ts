import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import {
  TtsClient,
  TtsProviderError,
  TtsTimeoutError,
  type TtsProvider,
  type TtsRequest,
} from "../../../src/server/tts/TtsClient.js";

const logger = pino({ level: "silent" });
const audio = { audio: Buffer.from([1, 2, 3]), mimeType: "audio/mpeg" };

function recordingProvider(impl?: TtsProvider["synthesize"]) {
  const requests: TtsRequest[] = [];
  const provider: TtsProvider = {
    synthesize: (req, signal) => {
      requests.push(req);
      return impl ? impl(req, signal) : Promise.resolve(audio);
    },
  };
  return { provider, requests };
}

describe("TtsClient", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the text with the configured model, voice, instructions, and mp3", async () => {
    const { provider, requests } = recordingProvider();
    const client = new TtsClient(
      provider,
      { model: "openai/gpt-4o-mini-tts-2025-12-15", voice: "onyx", instructions: "Whisper." },
      logger,
    );
    await expect(client.speak("The plex spirit sleeps.")).resolves.toEqual(audio);
    expect(requests).toEqual([
      {
        model: "openai/gpt-4o-mini-tts-2025-12-15",
        input: "The plex spirit sleeps.",
        voice: "onyx",
        instructions: "Whisper.",
        response_format: "mp3",
      },
    ]);
  });

  it.each([undefined, "", "   "])("omits instructions when configured as %j", async (instructions) => {
    const { provider, requests } = recordingProvider();
    const client = new TtsClient(provider, { model: "m", voice: "v", instructions }, logger);
    await client.speak("hello");
    expect(Object.keys(requests[0]!).sort()).toEqual(["input", "model", "response_format", "voice"]);
  });

  it("rejects with TtsTimeoutError and aborts the provider after 15 seconds by default", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    // A provider that ignores the signal and never settles.
    const { provider } = recordingProvider((_req, signal) => {
      seenSignal = signal;
      return new Promise(() => {});
    });
    const client = new TtsClient(provider, { model: "m", voice: "v" }, logger);
    const result = client.speak("hello");
    const assertion = expect(result).rejects.toBeInstanceOf(TtsTimeoutError);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(seenSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  });

  it("passes TtsProviderError through and wraps other provider errors", async () => {
    const providerError = new TtsProviderError("bad voice", 400);
    const client1 = new TtsClient(
      recordingProvider(() => Promise.reject(providerError)).provider,
      { model: "m", voice: "v" },
      logger,
    );
    await expect(client1.speak("x")).rejects.toBe(providerError);

    const client2 = new TtsClient(
      recordingProvider(() => Promise.reject(new Error("socket hang up"))).provider,
      { model: "m", voice: "v" },
      logger,
    );
    const err = await client2.speak("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsProviderError);
    expect((err as Error).message).toBe("socket hang up");
  });
});
