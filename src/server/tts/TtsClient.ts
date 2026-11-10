import type { Config } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";

/** The exact request body sent to the TTS provider. Nothing else may be added (Requirement 13.2). */
export interface TtsRequest {
  model: string;
  input: string;
  voice: string;
  instructions?: string;
  response_format: "mp3";
}

export interface TtsAudio {
  audio: Buffer;
  mimeType: string;
}

/** Test seam only: production always uses OpenRouterTts. Tests inject a mock. */
export interface TtsProvider {
  synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsAudio>;
}

export const DEFAULT_TTS_TIMEOUT_MS = 15_000;

/** The provider did not return audio within the timeout. The speech route maps this to 504. */
export class TtsTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Text-to-speech request timed out after ${timeoutMs} ms`);
    this.name = "TtsTimeoutError";
  }
}

/** The provider returned an error or unusable audio. The speech route maps this to 502. */
export class TtsProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TtsProviderError";
  }
}

export class TtsClient {
  constructor(
    private readonly provider: TtsProvider,
    private readonly settings: Config["tts"],
    private readonly logger: Logger,
  ) {}

  /**
   * Speaks `text` with the configured model, voice (9.2), and instructions (9.7), always as mp3 (9.6).
   * Rejects with TtsTimeoutError after `timeoutMs`, and with TtsProviderError for any other failure.
   */
  async speak(text: string, timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS): Promise<TtsAudio> {
    const req = this.buildRequest(text);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TtsTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    const started = Date.now();
    try {
      // The race also covers providers that ignore the abort signal.
      return await Promise.race([this.provider.synthesize(req, controller.signal), timeout]);
    } catch (err) {
      const mapped =
        err instanceof TtsTimeoutError || err instanceof TtsProviderError
          ? err
          : controller.signal.aborted
            ? new TtsTimeoutError(timeoutMs)
            : new TtsProviderError(err instanceof Error && err.message ? err.message : "Unknown TTS error");
      this.logger.warn(
        { err: mapped, model: req.model, textLength: text.length, elapsedMs: Date.now() - started },
        "text-to-speech request failed",
      );
      throw mapped;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildRequest(text: string): TtsRequest {
    const { model, voice, instructions } = this.settings;
    const req: TtsRequest = { model, input: text, voice, response_format: "mp3" };
    if (instructions !== undefined && instructions.trim().length > 0) req.instructions = instructions;
    return req;
  }
}
