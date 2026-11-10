import { describe, expect, it } from "vitest";
import { ContainerNotFoundError } from "../../../../src/server/datasource/types.js";
import { CRASH_LOG_TEXTS, restartLoopText } from "../../../../src/server/datasource/simulator/logs.js";
import { TICK_MS } from "../../../../src/server/datasource/simulator/noise.js";
import {
  clearIncidents,
  GHOST_CONTAINER,
  IncidentTargetRequiredError,
  initialState,
  observe,
  readLogsFromState,
  restartContainer,
  SIM_CONTAINER_NAMES,
  type SimState,
  stageIncident,
  stopContainer,
} from "../../../../src/server/datasource/simulator/state.js";

const MIB = 1024 ** 2;
const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);
const ERROR_WORDS = /\b(error|err|fatal|panic|exception|crit(ical)?)\b/i;

/** A simulator that has been observed once at T0. */
function started(seed = 1337): SimState {
  return observe(initialState(seed), T0).state;
}

const find = <T extends { name: string }>(containers: T[], name: string) => containers.find((c) => c.name === name);
const memoryFraction = (host: { memoryUsedBytes: number; memoryTotalBytes: number }) =>
  host.memoryUsedBytes / host.memoryTotalBytes;

describe("cpu_spike", () => {
  it("drives host CPU to 96-99 % and adds a running ghost container", () => {
    let s = stageIncident(started(), "cpu_spike", undefined, T0 + 1000);
    for (let t = T0 + 1000; t < T0 + 60_000; t += TICK_MS) {
      const view = observe(s, t);
      s = view.state;
      expect(view.host.cpuPercent).toBeGreaterThanOrEqual(96);
      expect(view.host.cpuPercent).toBeLessThanOrEqual(99);
      expect(view.containers.map((c) => c.name)).toEqual([...SIM_CONTAINER_NAMES, GHOST_CONTAINER]);
      const ghost = find(view.containers, GHOST_CONTAINER)!;
      expect(ghost).toMatchObject({ state: "running", memoryBytes: 64 * MIB });
      expect(ghost.cpuPercent).toBeGreaterThanOrEqual(96);
    }
  });

  it("is idempotent and starts the ghost's logs at the staging time", () => {
    const once = stageIncident(started(), "cpu_spike", undefined, T0 + 1000);
    expect(stageIncident(once, "cpu_spike", undefined, T0 + 1000)).toEqual(once);
    expect(once.incidents).toEqual([{ type: "cpu_spike", stagedAt: T0 + 1000 }]);
    const { lines } = readLogsFromState(once, GHOST_CONTAINER, 1000, T0 + 30_000);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(Date.parse(line.timestamp)).toBeGreaterThan(T0 + 1000);
  });

  it("stopping the ghost ends the host CPU effect and leaves it listed as exited", () => {
    const spiked = stageIncident(started(), "cpu_spike", undefined, T0);
    const stopped = stopContainer(spiked, GHOST_CONTAINER, T0 + 5000);
    const view = observe(stopped, T0 + 10_000);
    expect(find(view.containers, GHOST_CONTAINER)).toEqual({
      name: GHOST_CONTAINER,
      state: "exited",
      cpuPercent: 0,
      memoryBytes: 0,
    });
    expect(view.host.cpuPercent).toBeLessThan(50);
    expect(stopped.incidents.map((i) => i.type)).toEqual(["cpu_spike"]);

    const woken = stageIncident(stopped, "cpu_spike", undefined, T0 + 15_000);
    expect(find(observe(woken, T0 + 15_000).containers, GHOST_CONTAINER)?.state).toBe("running");
  });

  it("restarting the ghost removes cpu_spike and the ghost container", () => {
    const spiked = stageIncident(started(), "cpu_spike", undefined, T0);
    const healed = restartContainer(spiked, GHOST_CONTAINER, T0 + 5000);
    expect(healed.incidents).toEqual([]);
    const view = observe(healed, T0 + 10_000);
    expect(find(view.containers, GHOST_CONTAINER)).toBeUndefined();
    expect(view.host.cpuPercent).toBeLessThan(50);
  });
});

describe("disk_full", () => {
  it("fills / to 97 % and leaves /mnt/media alone", () => {
    const base = observe(started(), T0 + 5000).host.filesystems;
    const s = stageIncident(started(), "disk_full", undefined, T0);
    expect(stageIncident(s, "disk_full", undefined, T0)).toEqual(s);
    const [root, media] = observe(s, T0 + 5000).host.filesystems;
    expect(root!.usedBytes / root!.totalBytes).toBeCloseTo(0.97, 6);
    expect(media).toEqual(base[1]);
  });
});

describe("container_crash", () => {
  it("reports the target exited and appends three error lines once", () => {
    const s = stageIncident(started(), "container_crash", "plex", T0 + 2000);
    const tail = s.logs.get("plex")!.slice(-3);
    expect(tail.map((l) => l.text)).toEqual([...CRASH_LOG_TEXTS]);
    for (const line of tail) {
      expect(line.text).toMatch(ERROR_WORDS);
      expect(line.timestamp).toBe(new Date(T0 + 2000).toISOString());
    }
    const view = observe(s, T0 + 30_000);
    expect(find(view.containers, "plex")).toEqual({ name: "plex", state: "exited", cpuPercent: 0, memoryBytes: 0 });
    expect(view.state.logs.get("plex")).toEqual(s.logs.get("plex"));
  });

  it("keeps log lines up to the crash", () => {
    const s = stageIncident(started(), "container_crash", "pihole", T0 + 20_000);
    const beforeCrash = s.logs.get("pihole")!.slice(0, -3);
    expect(Date.parse(beforeCrash.at(-1)!.timestamp)).toBeGreaterThan(T0 + 10_000);
    expect(s.logCursor.get("pihole")).toBe(T0 + 20_000);
  });
});

describe("container_restart_loop", () => {
  it("reports the target restarting and repeats the startup failure line every tick", () => {
    let s = stageIncident(started(), "container_restart_loop", "homeassistant", T0 + 1000);
    for (let t = T0 + 5000; t <= T0 + 20_000; t += 2500) s = observe(s, t).state;
    const view = observe(s, T0 + 20_000);
    expect(find(view.containers, "homeassistant")).toEqual({
      name: "homeassistant",
      state: "restarting",
      cpuPercent: 0,
      memoryBytes: 0,
    });
    const text = restartLoopText("homeassistant");
    expect(text).toBe("ERROR: startup failed: could not bind to port 8123, retrying");
    const failures = view.state.logs.get("homeassistant")!.filter((l) => l.text === text);
    // One on staging, then one at each tick start in (T0+1000, T0+20000].
    expect(failures.length).toBe(1 + 4);
    const times = view.state.logs.get("homeassistant")!.map((l) => Date.parse(l.timestamp));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("memory_leak", () => {
  it("grows the target on every read until host memory reaches 95 %, then holds at or below 99 %", () => {
    let s = stageIncident(started(), "memory_leak", "uptime-kuma", T0);
    let previous = find(observe(started(), T0).containers, "uptime-kuma")!.memoryBytes;
    let reachedAt = -1;
    for (let read = 1; read <= 40; read++) {
      const view = observe(s, T0 + read * TICK_MS);
      s = view.state;
      const memory = find(view.containers, "uptime-kuma")!.memoryBytes;
      const fraction = memoryFraction(view.host);
      expect(fraction).toBeLessThanOrEqual(0.99);
      if (reachedAt < 0) {
        expect(memory).toBeGreaterThan(previous);
        if (fraction >= 0.95) reachedAt = read;
      }
      previous = memory;
    }
    expect(reachedAt).toBeGreaterThan(0);
    expect(reachedAt).toBeLessThanOrEqual(25);
  });

  it("does not grow on log reads", () => {
    const s = stageIncident(started(), "memory_leak", "plex", T0);
    const { state } = readLogsFromState(s, "plex", 10, T0 + 5000);
    expect(state.incidents).toEqual(s.incidents);
  });

  it("restart clears the leak", () => {
    let s = stageIncident(started(), "memory_leak", "plex", T0);
    for (let i = 1; i <= 5; i++) s = observe(s, T0 + i * TICK_MS).state;
    s = restartContainer(s, "plex", T0 + 30_000);
    expect(s.incidents).toEqual([]);
    expect(observe(s, T0 + 35_000).containers).toEqual(observe(initialState(1337), T0 + 35_000).containers);
  });
});

describe("staging rules", () => {
  it("rejects a container incident without a target", () => {
    for (const target of [undefined, "", "  "]) {
      expect(() => stageIncident(started(), "container_crash", target, T0)).toThrow(IncidentTargetRequiredError);
    }
  });

  it("rejects an unknown target with ContainerNotFoundError", () => {
    expect(() => stageIncident(started(), "memory_leak", "plexx", T0)).toThrow(ContainerNotFoundError);
    expect(() => stageIncident(started(), "container_crash", GHOST_CONTAINER, T0)).toThrow(ContainerNotFoundError);
  });

  it("keeps one container incident per container, the newest", () => {
    let s = stageIncident(started(), "container_crash", "plex", T0);
    s = stageIncident(s, "container_restart_loop", "plex", T0 + 1000);
    s = stageIncident(s, "memory_leak", "pihole", T0 + 2000);
    expect(s.incidents.map((i) => [i.type, i.target])).toEqual([
      ["container_restart_loop", "plex"],
      ["memory_leak", "pihole"],
    ]);
    expect(find(observe(s, T0 + 3000).containers, "plex")?.state).toBe("restarting");
  });

  it("staging on a stopped container brings the incident into effect", () => {
    let s = stopContainer(started(), "nginx-proxy", T0);
    s = stageIncident(s, "container_restart_loop", "nginx-proxy", T0 + 1000);
    expect(s.stopped.has("nginx-proxy")).toBe(false);
    expect(find(observe(s, T0 + 2000).containers, "nginx-proxy")?.state).toBe("restarting");
  });

  it("does not mutate its input", () => {
    const s = started();
    const logs = s.logs.get("plex")!.length;
    stageIncident(s, "container_crash", "plex", T0 + 10_000);
    stageIncident(s, "cpu_spike", undefined, T0 + 10_000);
    stopContainer(s, "pihole", T0 + 10_000);
    clearIncidents(s, T0 + 10_000);
    expect(s.incidents).toEqual([]);
    expect(s.stopped.size).toBe(0);
    expect(s.logs.get("plex")!.length).toBe(logs);
    expect(s.logCursor.get("plex")).toBe(T0);
  });
});

describe("restart and stop", () => {
  it("restart heals every container incident and reports running", () => {
    for (const type of ["memory_leak", "container_crash", "container_restart_loop"] as const) {
      const s = restartContainer(stageIncident(started(), type, "plex", T0), "plex", T0 + 5000);
      expect(s.incidents).toEqual([]);
      expect(find(observe(s, T0 + 10_000).containers, "plex")?.state).toBe("running");
    }
  });

  it("stop reports exited, removes container incidents, and restart brings it back", () => {
    let s = stageIncident(started(), "container_restart_loop", "pihole", T0);
    s = stageIncident(s, "disk_full", undefined, T0);
    s = stopContainer(s, "pihole", T0 + 5000);
    expect(s.incidents.map((i) => i.type)).toEqual(["disk_full"]);
    expect(find(observe(s, T0 + 10_000).containers, "pihole")?.state).toBe("exited");
    s = restartContainer(s, "pihole", T0 + 15_000);
    expect(find(observe(s, T0 + 20_000).containers, "pihole")?.state).toBe("running");
  });

  it("throws ContainerNotFoundError for unlisted names", () => {
    expect(() => restartContainer(started(), "nope", T0)).toThrow(ContainerNotFoundError);
    expect(() => stopContainer(started(), "nope", T0)).toThrow(ContainerNotFoundError);
    expect(() => stopContainer(started(), GHOST_CONTAINER, T0)).toThrow(ContainerNotFoundError);
  });
});

describe("clearIncidents", () => {
  it("returns every container and the host to the defaults and keeps logs", () => {
    let s = started();
    s = stageIncident(s, "cpu_spike", undefined, T0 + 1000);
    s = stageIncident(s, "disk_full", undefined, T0 + 1000);
    s = stageIncident(s, "memory_leak", "plex", T0 + 1000);
    s = stageIncident(s, "container_crash", "pihole", T0 + 1000);
    s = stopContainer(s, "uptime-kuma", T0 + 2000);
    for (let t = T0 + 5000; t <= T0 + 30_000; t += TICK_MS) s = observe(s, t).state;
    const cleared = clearIncidents(s, T0 + 31_000);
    expect(cleared.incidents).toEqual([]);
    expect(cleared.stopped.size).toBe(0);
    expect(cleared.logs.get("pihole")!.map((l) => l.text)).toEqual(expect.arrayContaining([...CRASH_LOG_TEXTS]));

    const after = observe(cleared, T0 + 40_000);
    const fresh = observe(initialState(1337), T0 + 40_000);
    expect(after.containers).toEqual(fresh.containers);
    expect(after.host).toEqual(fresh.host);
  });
});
