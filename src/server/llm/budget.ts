import type { WindowLimiter } from "../limits/limits.js";
import type { LlmProvider } from "./LlmClient.js";

/** The daily LLM call budget is used up. Alert messages fall back to their templates. */
export class LlmBudgetExceededError extends Error {
  override readonly name = "LlmBudgetExceededError";

  constructor() {
    super("Daily LLM call budget exhausted");
  }
}

/** Wraps a provider so every call counts against `budget`. Calls past the budget are rejected unsent. */
export function withLlmBudget(provider: LlmProvider, budget: WindowLimiter): LlmProvider {
  return {
    complete(req, signal) {
      if (!budget.take().ok) return Promise.reject(new LlmBudgetExceededError());
      return provider.complete(req, signal);
    },
  };
}
