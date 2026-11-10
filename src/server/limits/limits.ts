/**
 * Usage limits that keep a public demo from draining the OpenRouter credits.
 *
 * - Per-visitor limits keep one visitor from using up the shared budget.
 * - Daily limits cap total AI spend. They are a hard bound even if a visitor evades the
 *   per-visitor limit by spoofing X-Forwarded-For.
 *
 * Every limit is a fixed window that starts with the first use after the previous window ended.
 */

import type { Clock } from "../../shared/types.js";

export const GLOBAL_KEY = "global";
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Chat questions per visitor per 10 minutes. */
export const CHAT_PER_CLIENT = { max: 15, windowMs: 10 * 60 * 1000 } as const;
/** Newly synthesized speech clips per visitor per 10 minutes. Replays of cached clips are free. */
export const SPEECH_PER_CLIENT = { max: 40, windowMs: 10 * 60 * 1000 } as const;

export type TakeResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Prune expired windows once the map grows past this many keys. */
const PRUNE_AT = 5_000;

export class WindowLimiter {
  readonly max: number;
  readonly windowMs: number;
  readonly #clock: Clock;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(max: number, windowMs: number, clock: Clock) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`max must be a positive integer, got ${max}`);
    if (!(windowMs > 0)) throw new RangeError(`windowMs must be positive, got ${windowMs}`);
    this.max = max;
    this.windowMs = windowMs;
    this.#clock = clock;
  }

  /** Counts one use for `key`, or reports how long until the next use is allowed. */
  take(key: string = GLOBAL_KEY): TakeResult {
    const now = this.#clock.now();
    const window = this.#current(key, now);
    if (window.count >= this.max) return { ok: false, retryAfterMs: window.start + this.windowMs - now };
    window.count++;
    return { ok: true };
  }

  /** True when `key` has a use left in its current window. Counts nothing. */
  hasRoom(key: string = GLOBAL_KEY): boolean {
    const window = this.#windows.get(key);
    return window === undefined || this.#clock.now() - window.start >= this.windowMs || window.count < this.max;
  }

  #current(key: string, now: number): { start: number; count: number } {
    let window = this.#windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      if (window === undefined && this.#windows.size >= PRUNE_AT) this.#prune(now);
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    return window;
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.windowMs) this.#windows.delete(key);
    }
  }
}

export interface UsageLimits {
  chatPerClient: WindowLimiter;
  speechPerClient: WindowLimiter;
  /** Every LLM call: chat answers, their retries, and alert messages. */
  llmDaily: WindowLimiter;
  /** Every newly synthesized speech clip. */
  speechDaily: WindowLimiter;
}

export function createUsageLimits(daily: { llmCalls: number; speechClips: number }, clock: Clock): UsageLimits {
  return {
    chatPerClient: new WindowLimiter(CHAT_PER_CLIENT.max, CHAT_PER_CLIENT.windowMs, clock),
    speechPerClient: new WindowLimiter(SPEECH_PER_CLIENT.max, SPEECH_PER_CLIENT.windowMs, clock),
    llmDaily: new WindowLimiter(daily.llmCalls, DAY_MS, clock),
    speechDaily: new WindowLimiter(daily.speechClips, DAY_MS, clock),
  };
}

/** Whole seconds for a Retry-After header, at least 1. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
