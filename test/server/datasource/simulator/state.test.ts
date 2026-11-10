import { describe, expect, it } from "vitest";
import { ContainerNotFoundError } from "../../../../src/server/datasource/types.js";
import {
  defaultLinesBetween,
  defaultLinesForTick,
  SERVICE_LOG_TEMPLATES,
} from "../../../../src/server/datasource/simulator/logs.js";
import { TICK_MS } from "../../../../src/server/datasource/simulator/noise.js";
import {
  HOST_MEMORY_TOTAL_BYTES,
  initialState,
  LOG_BACKFILL_MS,
  LOG_BUFFER_LINES,
  observe,
  readLogsFromState,
  SIM_CONTAINER_NAMES,
  type SimState,
} from "../../../../src/server/datasource/simulator/state.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);
const ERROR_WORDS = /\b(error|err|fatal|panic|exception|crit(ical)?)\b/i;

/** Observes every `stepMs` from `from` to `to` inclusive and returns the final state. */
function observeEvery(s: SimState, from: number, to: number, stepMs: number): SimState {
  let state = s;
  for (let t = from; t <= to; t += stepMs) state = observe(state, t).state;
  return state;
}

describe("simulator default model", () => {
  it("reports the five services, all running within the design ranges", () => {
    for (const now of [T0, T0 + 12_345, T0 + 3_600_000 * 7]) {
      const { containers, host } = observe(initialState(1337), now);
      expect(containers.map((c) => c.name)).toEqual([...SIM_CONTAINER_NAMES]);
      expect(SIM_CONTAINER_NAMES).toEqual(["plex", "pihole", "homeassistant", "nginx-proxy", "uptime-kuma"]);
      for (const c of containers) {
        expect(c.state).toBe("running");
        expect(c.cpuPercent).toBeGreaterThanOrEqual(2);
        expect(c.cpuPercent).toBeLessThanOrEqual(25);
        expect(c.memoryBytes).toBeGreaterThanOrEqual(150 * MIB);
        expect(c.memoryBytes).toBeLessThanOrEqual(1.5 * GIB);
      }
      const containerMemory = containers.reduce((sum, c) => sum + c.memoryBytes, 0);
      expect(containerMemory).toBeLessThan(10 * GIB);
      expect(host.memoryTotalBytes).toBe(32 * GIB);
      expect(host.memoryUsedBytes).toBe(4 * GIB + containerMemory);
      expect(host.memoryUsedBytes / host.memoryTotalBytes).toBeLessThan(0.45);
      expect(host.cpuPercent).toBeGreaterThan(0);
      expect(host.cpuPercent).toBeLessThan(50);
      expect(host.filesystems.map((f) => f.mount)).toEqual(["/", "/mnt/media"]);
      const [root, media] = host.filesystems;
      expect(root!.usedBytes / root!.totalBytes).toBeGreaterThanOrEqual(0.35);
      expect(root!.usedBytes / root!.totalBytes).toBeLessThanOrEqual(0.45);
      expect(media!.usedBytes / media!.totalBytes).toBeGreaterThanOrEqual(0.55);
      expect(media!.usedBytes / media!.totalBytes).toBeLessThanOrEqual(0.65);
    }
  });

  it("is a pure function of seed and time", () => {
    const a = observe(initialState(7), T0 + 20_000);
    const b = observe(observe(initialState(7), T0).state, T0 + 20_000);
    expect(b.containers).toEqual(a.containers);
    expect(b.host).toEqual(a.host);
    expect(observe(initialState(8), T0).containers).not.toEqual(observe(initialState(7), T0).containers);
  });

  it("does not mutate the input state", () => {
    const s = initialState(1);
    observe(s, T0);
    expect(s.logs.size).toBe(0);
    expect(s.logCursor.size).toBe(0);
  });

  it("reports a stopped container as exited with zero CPU and memory and gives it no new logs", () => {
    const first = observe(initialState(1337), T0).state;
    const before = first.logs.get("plex")!.length;
    const stopped: SimState = { ...first, stopped: new Set(["plex"]) };
    const { state, containers, host } = observe(stopped, T0 + 60_000);
    expect(containers.find((c) => c.name === "plex")).toEqual({
      name: "plex",
      state: "exited",
      cpuPercent: 0,
      memoryBytes: 0,
    });
    const running = containers.filter((c) => c.name !== "plex");
    expect(host.memoryUsedBytes).toBe(4 * GIB + running.reduce((sum, c) => sum + c.memoryBytes, 0));
    expect(state.logs.get("plex")!.length).toBe(before);
    expect(state.logs.get("pihole")!.length).toBeGreaterThan(first.logs.get("pihole")!.length);
    expect(HOST_MEMORY_TOTAL_BYTES).toBe(32 * GIB);
  });
});

describe("simulator log generation", () => {
  it("produces one or two lines per tick, inside the tick, oldest first", () => {
    for (const name of [...SIM_CONTAINER_NAMES, "unknown-process-x13"]) {
      for (let tick = 0; tick < 50; tick++) {
        const lines = defaultLinesForTick(1337, name, 400_000_000 + tick);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines.length).toBeLessThanOrEqual(2);
        const start = (400_000_000 + tick) * TICK_MS;
        let prev = -Infinity;
        for (const line of lines) {
          const at = Date.parse(line.timestamp);
          expect(at).toBeGreaterThanOrEqual(start);
          expect(at).toBeLessThan(start + TICK_MS);
          expect(at).toBeGreaterThan(prev);
          prev = at;
          expect(line.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("has templates for every default service and no error keywords in default lines", () => {
    expect(Object.keys(SERVICE_LOG_TEMPLATES).sort()).toEqual([...SIM_CONTAINER_NAMES].sort());
    const lines = SIM_CONTAINER_NAMES.flatMap((n) => defaultLinesBetween(1337, n, T0, T0 + 3_600_000));
    for (const line of lines) expect(line.text).not.toMatch(ERROR_WORDS);
  });

  it("backfills on first observation and adds lines in every 10-second window", () => {
    const state = observeEvery(initialState(1337), T0, T0 + 120_000, 5000);
    for (const name of SIM_CONTAINER_NAMES) {
      const times = state.logs.get(name)!.map((l) => Date.parse(l.timestamp));
      expect(times[0]).toBeGreaterThan(T0 - LOG_BACKFILL_MS);
      expect(times[0]).toBeLessThan(T0 - LOG_BACKFILL_MS + 10_000);
      expect(times.at(-1)).toBeLessThanOrEqual(T0 + 120_000);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(new Set(times).size).toBe(times.length);
      for (let start = T0 - LOG_BACKFILL_MS; start + 10_000 <= T0 + 120_000; start += 1000) {
        expect(times.some((t) => t >= start && t <= start + 10_000)).toBe(true);
      }
    }
  });

  it("generates the same lines whether observed often or rarely", () => {
    const often = observeEvery(initialState(9), T0, T0 + 60_000, 1000);
    const rarely = observe(observe(initialState(9), T0).state, T0 + 60_000).state;
    expect(rarely.logs).toEqual(often.logs);
  });

  it("keeps at most 1000 lines per container", () => {
    const state = observeEvery(initialState(1337), T0, T0 + 1500 * TICK_MS, 60 * TICK_MS);
    for (const name of SIM_CONTAINER_NAMES) {
      const lines = state.logs.get(name)!;
      expect(lines.length).toBe(LOG_BUFFER_LINES);
      expect(Date.parse(lines.at(-1)!.timestamp)).toBeGreaterThan(T0 + 1499 * TICK_MS);
    }
  });
});

describe("readLogsFromState", () => {
  it("fills lazy ticks and returns the most recent lines, oldest first", () => {
    const s = observe(initialState(1337), T0).state;
    const { state, lines } = readLogsFromState(s, "pihole", 5, T0 + 30_000);
    const all = state.logs.get("pihole")!;
    expect(lines).toEqual(all.slice(-5));
    expect(Date.parse(lines.at(-1)!.timestamp)).toBeGreaterThan(T0 + 20_000);
    expect(state.logCursor.get("pihole")).toBe(T0 + 30_000);
  });

  it("returns every line when fewer exist than requested, and none for zero", () => {
    const s = initialState(1337);
    const { state, lines } = readLogsFromState(s, "plex", 10_000, T0);
    expect(lines).toEqual(state.logs.get("plex"));
    expect(readLogsFromState(s, "plex", 0, T0).lines).toEqual([]);
  });

  it("throws ContainerNotFoundError for an unknown container", () => {
    expect(() => readLogsFromState(initialState(1), "plexx", 10, T0)).toThrow(ContainerNotFoundError);
  });
});
