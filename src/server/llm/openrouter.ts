import { OpenAI, APIError, APIUserAbortError } from "openai";
import { LlmProviderError, type LlmProvider, type LlmRequest } from "./LlmClient.js";

export interface OpenRouterLlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Test seam: custom fetch implementation. Production uses the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Chat completions through OpenRouter's OpenAI-compatible endpoint
 * (`POST {baseUrl}/chat/completions`), using the official `openai` SDK.
 */
export class OpenRouterLlm implements LlmProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(opts: OpenRouterLlmOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      maxRetries: 0,
      defaultHeaders: { "X-Title": "Haunted Homelab" },
      // Keep OPENAI_* environment values (org, project) out of requests to OpenRouter.
      organization: null,
      project: null,
      // The SDK logs to console by default, which would bypass the scrubbing logger.
      logLevel: "off",
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async complete(req: LlmRequest, signal: AbortSignal): Promise<string> {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [{ role: "system", content: req.system }, ...req.messages],
          max_tokens: req.maxTokens,
          ...(req.json ? { response_format: { type: "json_object" as const } } : {}),
        },
        { signal, maxRetries: 0 },
      );
    } catch (err) {
      // Let the abort surface as-is so LlmClient reports it as a timeout.
      if (err instanceof APIUserAbortError || signal.aborted) throw err;
      throw this.toProviderError(err);
    }

    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new LlmProviderError("OpenRouter returned an empty completion");
    }
    return content;
  }

  private toProviderError(err: unknown): LlmProviderError {
    const raw = err instanceof Error ? err.message : String(err);
    const message = `OpenRouter request failed: ${this.redact(raw)}`;
    const status = err instanceof APIError ? err.status : undefined;
    // The SDK error is not kept as `cause`: it carries request headers that include the key.
    return new LlmProviderError(message, status);
  }

  private redact(text: string): string {
    return this.apiKey.length > 0 ? text.split(this.apiKey).join("[REDACTED]") : text;
  }
}
