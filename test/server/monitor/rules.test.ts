import { describe, expect, it } from "vitest";
import {
  evaluateRules,
  initialRuleState,
  subjectKey,
  type MonitorInput,
  type RuleState,
} from "../../../src/server/monitor/rules.js";
import { subjectKey as sharedSubjectKey } from "../../../src/shared/severity.js";
import type { ContainerInfo, HostMetrics, Snapshot, Thresholds } from "../../../src/shared/types.js";

const GiB = 1024 ** 3;
const T: Thresholds = { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 };
const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);

function host(over: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpuPercent: 10,
    memoryUsedBytes: 8 * GiB,
    memoryTotalBytes: 32 * GiB,
    filesystems: [
      { mount: "/", usedBytes: 40, totalBytes: 100 },
      { mount: "/mnt/media", usedBytes: 60, totalBytes: 100 },
    ],
    ...over,
  };
}

function c(name: string, state: ContainerInfo["state"] = "running", cpuPercent = 5): ContainerInfo {
  return { name, state, cpuPercent, memoryBytes: 256 * 1024 ** 2 };
}

function snap(atSec: number, containers: ContainerInfo[] = [c("plex")], h: HostMetrics = host()): MonitorInput {
  const s: Snapshot = { readAt: new Date(T0 + atSec * 1000).toISOString(), containers, host: h };
  return { ok: true, snapshot: s };
}

function err(atSec: number): MonitorInput {
  return { ok: false, at: new Date(T0 + atSec * 1000).toISOString(), error: "Data source unavailable at unix:///var/run/docker.sock" };
}

/** Feeds inputs in order and returns every step's result. */
function run(inputs: MonitorInput[], start: RuleState = initialRuleState()) {
  let state = start;
  return inputs.map((input) => {
    const r = evaluateRules(state, input, T);
    state = r.state;
    return r;
  });
}

const keys = (events: { key: string }[]) => events.map((e) => e.key);

describe("evaluateRules", () => {
  it("re-exports the shared subjectKey", () => {
    expect(subjectKey).toBe(sharedSubjectKey);
  });

  it("raises host_cpu only after CPU stays above the threshold for the duration", () => {
    const hot = host({ cpuPercent: 97.34 });
    const steps = run([snap(0, [], hot), snap(25, [], hot), snap(30, [], hot), snap(35, [], hot), snap(40, [])]);
    expect(steps.map((s) => keys(s.raised))).toEqual([[], [], ["host_cpu:host:cpu"], [], []]);
    expect(steps[2]!.raised[0]).toMatchObject({ severity: "warning", measuredValue: "97.3%" });
    expect(keys(steps[4]!.resolved)).toEqual(["host_cpu:host:cpu"]);
  });

  it("restarts the CPU run when a snapshot drops to the threshold", () => {
    const hot = host({ cpuPercent: 95 });
    const steps = run([snap(0, [], hot), snap(20, [], host({ cpuPercent: 90 })), snap(40, [], hot), snap(65, [], hot)]);
    expect(steps.every((s) => s.raised.length === 0)).toBe(true);
  });

  it("raises memory and per-mount disk alerts strictly above the threshold", () => {
    const h = host({
      memoryUsedBytes: 30.4 * GiB,
      filesystems: [
        { mount: "/", usedBytes: 97, totalBytes: 100 },
        { mount: "/mnt/media", usedBytes: 90, totalBytes: 100 },
      ],
    });
    const [step] = run([snap(0, [], h)]);
    expect(keys(step!.raised)).toEqual(["host_memory:host:memory", "disk:filesystem:/"]);
    expect(step!.raised.map((e) => e.measuredValue)).toEqual(["95.0%", "97.0%"]);
  });

  it("latches container_exited on running -> exited and resolves when it runs again", () => {
    const steps = run([
      snap(0, [c("plex"), c("pihole", "exited")]),
      snap(5, [c("plex", "exited"), c("pihole", "exited")]),
      snap(10, [c("plex", "exited")]),
      snap(15, [c("plex")]),
    ]);
    expect(keys(steps[0]!.raised)).toEqual([]); // pihole was never seen running
    expect(steps[1]!.raised).toEqual([
      expect.objectContaining({ key: "container_exited:container:plex", severity: "critical", measuredValue: "exited" }),
    ]);
    expect(steps[2]!.raised).toEqual([]);
    expect(keys(steps[3]!.resolved)).toEqual(["container_exited:container:plex"]);
  });

  it("raises container_restarting while the state is restarting", () => {
    const steps = run([snap(0, [c("plex", "restarting")]), snap(5, [c("plex", "restarting")]), snap(10, [c("plex")])]);
    expect(keys(steps[0]!.raised)).toEqual(["container_restarting:container:plex"]);
    expect(steps[1]!.raised).toEqual([]);
    expect(keys(steps[2]!.resolved)).toEqual(["container_restarting:container:plex"]);
  });

  it("raises new_container_cpu only for hot containers absent from a previous snapshot", () => {
    const ghost = c("unknown-process-x13", "running", 97.5);
    const first = run([snap(0, [c("plex"), ghost])]);
    expect(first[0]!.raised).toEqual([]);

    const steps = run([snap(0, [c("plex")]), snap(5, [c("plex"), ghost]), snap(10, [c("plex"), ghost]), snap(15, [c("plex")])]);
    expect(steps[1]!.raised).toEqual([
      expect.objectContaining({
        key: "new_container_cpu:container:unknown-process-x13",
        severity: "warning",
        measuredValue: "97.5%",
      }),
    ]);
    expect(steps[2]!.raised).toEqual([]);
    expect(keys(steps[3]!.resolved)).toEqual(["new_container_cpu:container:unknown-process-x13"]);
  });

  it("does not raise new_container_cpu for a known container that becomes hot", () => {
    const steps = run([snap(0, [c("plex")]), snap(5, [c("plex", "running", 99)])]);
    expect(steps[1]!.raised).toEqual([]);
  });

  it("raises one data_source_unavailable alert per outage and keeps other alerts untouched", () => {
    const hot = host({ cpuPercent: 99 });
    const steps = run([snap(0, [c("plex", "restarting")], hot), err(5), err(10), snap(30, [c("plex", "restarting")], hot), err(35)]);
    expect(steps[1]!.raised).toEqual([
      expect.objectContaining({ key: "data_source_unavailable:data_source", severity: "critical" }),
    ]);
    expect(steps[1]!.resolved).toEqual([]);
    expect(steps[2]!.raised).toEqual([]);
    // CPU run survives the errors: 0 -> 30 s is sustained.
    expect(keys(steps[3]!.raised)).toEqual(["host_cpu:host:cpu"]);
    expect(keys(steps[3]!.resolved)).toEqual(["data_source_unavailable:data_source"]);
    expect(keys(steps[4]!.raised)).toEqual(["data_source_unavailable:data_source"]);
  });

  it("does not mutate the input state", () => {
    const [a] = run([snap(0, [c("plex")])]);
    const before = a!.state;
    const activeSize = before.active.size;
    const prev = before.previous;
    const r = evaluateRules(before, snap(5, [c("plex", "exited")], host({ memoryUsedBytes: 31 * GiB })), T);
    expect(r.raised.length).toBe(2);
    expect(before.active.size).toBe(activeSize);
    expect(before.exitedLatch.size).toBe(0);
    expect(before.previous).toBe(prev);
    const e = evaluateRules(r.state, err(10), T);
    expect(r.state.active.has("data_source_unavailable:data_source")).toBe(false);
    expect(e.state.active.has("data_source_unavailable:data_source")).toBe(true);
  });
});
