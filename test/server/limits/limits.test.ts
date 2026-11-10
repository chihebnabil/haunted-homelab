import { describe, expect, it } from "vitest";
import { createUsageLimits, retryAfterSeconds, WindowLimiter } from "../../../src/server/limits/limits.js";
import { LlmBudgetExceededError, withLlmBudget } from "../../../src/server/llm/budget.js";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("WindowLimiter", () => {
  it("allows max uses per window per key, then reports when the window ends", () => {
    const c = clock();
    const limiter = new WindowLimiter(2, 1000, c);
    expect(limiter.take("a")).toEqual({ ok: true });
    c.advance(100);
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.hasRoom("a")).toBe(false);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterMs: 900 });
    expect(limiter.take("b")).toEqual({ ok: true });

    c.advance(900);
    expect(limiter.hasRoom("a")).toBe(true);
    expect(limiter.take("a")).toEqual({ ok: true });
  });

  it("does not count uses in hasRoom", () => {
    const limiter = new WindowLimiter(1, 1000, clock());
    expect(limiter.hasRoom()).toBe(true);
    expect(limiter.hasRoom()).toBe(true);
    expect(limiter.take()).toEqual({ ok: true });
    expect(limiter.hasRoom()).toBe(false);
  });

  it("rejects invalid limits", () => {
    expect(() => new WindowLimiter(0, 1000, clock())).toThrow(RangeError);
    expect(() => new WindowLimiter(1, 0, clock())).toThrow(RangeError);
  });

  it("rounds Retry-After up to whole seconds, at least 1", () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1500)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
  });
});

describe("withLlmBudget", () => {
  it("passes calls through until the daily budget is used, then rejects without calling the provider", async () => {
    let calls = 0;
    const limits = createUsageLimits({ llmCalls: 2, speechClips: 1 }, clock());
    const provider = withLlmBudget({ complete: async () => `reply ${++calls}` }, limits.llmDaily);
    const req = { system: "s", messages: [], maxTokens: 10, json: false };
    const signal = new AbortController().signal;

    await expect(provider.complete(req, signal)).resolves.toBe("reply 1");
    await expect(provider.complete(req, signal)).resolves.toBe("reply 2");
    await expect(provider.complete(req, signal)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(calls).toBe(2);
  });
});
