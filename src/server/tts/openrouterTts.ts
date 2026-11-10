import { TtsProviderError, type TtsAudio, type TtsProvider, type TtsRequest } from "./TtsClient.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterTtsOptions {
  apiKey: string;
  baseUrl: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
}

/** Calls OpenRouter's OpenAI-compatible `POST {baseUrl}/audio/speech` endpoint. */
export class OpenRouterTts implements TtsProvider {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OpenRouterTtsOptions) {
    this.apiKey = opts.apiKey;
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/audio/speech`;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsAudio> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Haunted Homelab",
        },
        body: JSON.stringify(req),
        signal,
      });
    } catch (err) {
      // An abort is the caller's timeout; let TtsClient turn it into TtsTimeoutError.
      if (signal.aborted) throw err;
      throw new TtsProviderError(this.scrub(`OpenRouter TTS request failed: ${messageOf(err)}`));
    }

    if (res.status !== 200) {
      throw new TtsProviderError(this.scrub(await errorMessage(res)), res.status);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new TtsProviderError("OpenRouter TTS returned empty audio", res.status);
    return { audio, mimeType: "audio/mpeg" };
  }

  /** Error text never carries the API key, even if a provider echoes it back. */
  private scrub(message: string): string {
    return this.apiKey.length > 0 ? message.split(this.apiKey).join("[REDACTED]") : message;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** Reads OpenRouter's JSON error body (`{ error: { message } }`), falling back to the HTTP status. */
async function errorMessage(res: Response): Promise<string> {
  const fallback = `OpenRouter TTS request failed with HTTP ${res.status}`;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fallback;
  }
  const error = (body as { error?: unknown } | null)?.error;
  const message =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown } | undefined)?.message === "string"
        ? (error as { message: string }).message
        : undefined;
  return message && message.trim().length > 0 ? `${fallback}: ${message}` : fallback;
}
