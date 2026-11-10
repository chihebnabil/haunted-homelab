import type { Logger } from "../logging/logger.js";

/** A provider-neutral chat completion request built by the Agent's prompt builder. */
export interface LlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  /** Ask the model for a JSON object response. Not every model honors this. */
  json: boolean;
}

/** Test seam only: production always uses OpenRouterLlm. Tests inject a mock. */
export interface LlmProvider {
  complete(req: LlmRequest, signal: AbortSignal): Promise<string>;
}

/** The LLM did not answer before the timeout or deadline. Routes map this to 504. */
export class LlmTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs} ms`);
    this.name = "LlmTimeoutError";
  }
}

/** The LLM provider returned an error or an unusable response. Routes map this to 502. */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmProviderError";
  }
}

/**
 * Wraps an LlmProvider with a hard timeout. The provider receives an AbortSignal that fires
 * at the timeout, and the returned promise rejects with LlmTimeoutError at that moment even
 * if the provider ignores the signal. No retries happen here; the Agent controls retries.
 */
export class LlmClient {
  constructor(
    private readonly provider: LlmProvider,
    private readonly logger: Logger,
  ) {}

  async complete(req: LlmRequest, timeoutMs: number): Promise<string> {
    if (!(timeoutMs > 0)) throw new LlmTimeoutError(Math.max(0, timeoutMs || 0));

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LlmTimeoutError(timeoutMs));
      }, timeoutMs);
    });

    const started = Date.now();
    try {
      return await Promise.race([this.provider.complete(req, controller.signal), timeout]);
    } catch (err) {
      const error = controller.signal.aborted ? new LlmTimeoutError(timeoutMs) : toProviderError(err);
      this.logger.warn(
        { err: error, status: error instanceof LlmProviderError ? error.status : undefined, elapsedMs: Date.now() - started },
        "LLM request failed",
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toProviderError(err: unknown): LlmProviderError {
  if (err instanceof LlmProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LlmProviderError(`LLM provider error: ${message}`, undefined, { cause: err });
}
