/**
 * Monitor scheduler (Requirements 4.1, 4.10).
 *
 * Polls the Data_Source on a `setTimeout` loop whose ticks are anchored at
 * `start + n·interval`, so slow callbacks do not make the schedule drift. Each tick
 * reads a Snapshot with a timeout of `min(interval, 10 s)`; a failed or timed-out read
 * becomes an error input for the rule engine. A tick that arrives while the previous
 * read is still in flight (including a timed-out read that has not settled yet) is
 * skipped instead of overlapping it. Polling continues after read errors and after
 * callback exceptions.
 */

import { readSnapshot } from "../datasource/snapshot.js";
import type { DataSource } from "../datasource/types.js";
import type { Logger } from "../logging/logger.js";
import type { AlertEvent, Clock, Snapshot, Thresholds } from "../../shared/types.js";
import { evaluateRules, initialRuleState, type MonitorInput, type RuleState } from "./rules.js";

/** Upper bound for a single snapshot read. */
export const MAX_READ_TIMEOUT_MS = 10_000;

export interface MonitorDeps {
  ds: DataSource;
  clock: Clock;
  thresholds: Thresholds;
  pollIntervalMs: number;
  logger: Logger;
  /** Called after every successful read, before `onEvents`. */
  onSnapshot: (snapshot: Snapshot) => void | Promise<void>;
  /** Called after every read (successful or not) that raised or resolved at least one alert. */
  onEvents: (raised: AlertEvent[], resolved: AlertEvent[]) => void | Promise<void>;
}

class ReadTimeoutError extends Error {
  override readonly name = "ReadTimeoutError";
  constructor(ms: number) {
    super(`Data source read timed out after ${ms} ms`);
  }
}

export class Monitor {
  private readonly deps: MonitorDeps;
  private readonly intervalMs: number;
  private readonly readTimeoutMs: number;

  private running = false;
  /** Incremented on every start and stop so results of an abandoned run are ignored. */
  private generation = 0;
  private startAt = 0;
  private tickIndex = 0;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private ruleState: RuleState = initialRuleState();
  private latest: Snapshot | undefined;

  constructor(deps: MonitorDeps) {
    if (!Number.isFinite(deps.pollIntervalMs) || deps.pollIntervalMs <= 0) {
      throw new RangeError(`pollIntervalMs must be a positive number, got ${deps.pollIntervalMs}`);
    }
    this.deps = deps;
    this.intervalMs = deps.pollIntervalMs;
    this.readTimeoutMs = Math.min(deps.pollIntervalMs, MAX_READ_TIMEOUT_MS);
  }

  /** Starts polling. The first read runs immediately. Calling start twice has no effect. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.startAt = this.deps.clock.now();
    this.tickIndex = 0;
    this.tick(this.generation);
  }

  /** Stops polling. A read in flight finishes silently: its result is not evaluated. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.reading = false;
    if (this.tickTimer !== undefined) clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
  }

  /** The latest successful Snapshot, if any. */
  latestSnapshot(): Snapshot | undefined {
    return this.latest;
  }

  private tick(gen: number): void {
    if (!this.running || gen !== this.generation) return;

    if (this.reading) {
      this.deps.logger.warn({ tick: this.tickIndex }, "monitor: previous snapshot read still running, skipping tick");
    } else {
      void this.poll(gen);
    }
    this.scheduleNext(gen);
  }

  private scheduleNext(gen: number): void {
    const now = this.deps.clock.now();
    let next = this.tickIndex + 1;
    // If the process fell behind, jump to the next boundary that is not in the past.
    const behind = Math.floor((now - this.startAt) / this.intervalMs) + 1;
    if (behind > next) next = behind;
    this.tickIndex = next;
    const delay = Math.max(0, this.startAt + next * this.intervalMs - now);
    this.tickTimer = setTimeout(() => this.tick(gen), delay);
  }

  private async poll(gen: number): Promise<void> {
    this.reading = true;
    const read = readSnapshot(this.deps.ds, this.deps.clock);
    // A timed-out read is reported as an error right away, but the next read waits until
    // the underlying read settles, so hung requests do not pile up on the data source.
    read.then(
      () => this.readSettled(gen),
      () => this.readSettled(gen),
    );

    let input: MonitorInput;
    try {
      const snapshot = await this.withTimeout(read);
      input = { ok: true, snapshot };
    } catch (err) {
      input = {
        ok: false,
        at: new Date(this.deps.clock.now()).toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (gen !== this.generation) return;

    if (!input.ok) {
      this.deps.logger.warn({ error: input.error }, "monitor: snapshot read failed");
    }

    let raised: AlertEvent[];
    let resolved: AlertEvent[];
    try {
      const result = evaluateRules(this.ruleState, input, this.deps.thresholds);
      this.ruleState = result.state;
      raised = result.raised;
      resolved = result.resolved;
    } catch (err) {
      this.deps.logger.error({ err }, "monitor: rule evaluation failed");
      return;
    }

    if (input.ok) {
      this.latest = input.snapshot;
      this.invoke("onSnapshot", () => this.deps.onSnapshot(input.snapshot));
    }
    if (raised.length > 0 || resolved.length > 0) {
      this.invoke("onEvents", () => this.deps.onEvents(raised, resolved));
    }
  }

  private readSettled(gen: number): void {
    if (gen === this.generation) this.reading = false;
  }

  private withTimeout(read: Promise<Snapshot>): Promise<Snapshot> {
    const ms = this.readTimeoutMs;
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ReadTimeoutError(ms)), ms);
      read.then(
        (s) => {
          clearTimeout(timer);
          resolve(s);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** Runs a callback, logging sync throws and async rejections so the loop keeps going. */
  private invoke(name: string, fn: () => void | Promise<void>): void {
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).then === "function") {
        (r as Promise<void>).catch((err: unknown) => {
          this.deps.logger.error({ err }, `monitor: ${name} callback failed`);
        });
      }
    } catch (err) {
      this.deps.logger.error({ err }, `monitor: ${name} callback failed`);
    }
  }
}
