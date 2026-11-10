import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Monitor, type MonitorDeps } from "../../../src/server/monitor/Monitor.js";
import { DataSourceUnavailableError, type DataSource } from "../../../src/server/datasource/types.js";
import { createLogger } from "../../../src/server/logging/logger.js";
import type { AlertEvent, ContainerInfo, HostMetrics, Snapshot, Thresholds } from "../../../src/shared/types.js";

const GiB = 1024 ** 3;
const T: Thresholds = { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 };
const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);

const HOST: HostMetrics = {
  cpuPercent: 10,
  memoryUsedBytes: 8 * GiB,
  memoryTotalBytes: 32 * GiB,
  filesystems: [{ mount: "/", usedBytes: 40, totalBytes: 100 }],
};

/** A data source whose reads are controlled by the test. */
class FakeSource implements DataSource {
  readonly kind = "simulator" as const;
  reads: number[] = [];
  containers: ContainerInfo[] = [{ name: "plex", state: "running", cpuPercent: 5, memoryBytes: GiB }];
  fail: Error | undefined;
  delayMs = 0;

  async listContainers(): Promise<ContainerInfo[]> {
    this.reads.push(Date.now() - T0);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw this.fail;
    return this.containers.map((c) => ({ ...c }));
  }
  async readHostMetrics(): Promise<HostMetrics> {
    return HOST;
  }
  async readLogs(): Promise<never[]> {
    return [];
  }
  async restart(): Promise<void> {}
  async stop(): Promise<void> {}
}

const silentLogger = createLogger([], { write: () => {} });

function makeMonitor(ds: FakeSource, over: Partial<MonitorDeps> = {}) {
  const snapshots: Snapshot[] = [];
  const events: { raised: AlertEvent[]; resolved: AlertEvent[] }[] = [];
  const monitor = new Monitor({
    ds,
    clock: { now: () => Date.now() },
    thresholds: T,
    pollIntervalMs: 5000,
    logger: silentLogger,
    onSnapshot: (s) => {
      snapshots.push(s);
    },
    onEvents: (raised, resolved) => {
      events.push({ raised, resolved });
    },
    ...over,
  });
  return { monitor, snapshots, events };
}

describe("Monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at 0, 5 s and 10 s by default", async () => {
    const ds = new FakeSource();
    const { monitor, snapshots } = makeMonitor(ds);
    monitor.start();
    await vi.advanceTimersByTimeAsync(10_000);
    monitor.stop();
    expect(ds.reads).toEqual([0, 5000, 10_000]);
    expect(snapshots).toHaveLength(3);
    expect(monitor.latestSnapshot()?.readAt).toBe(new Date(T0 + 10_000).toISOString());
  });

  it("polls at a configured interval", async () => {
    const ds = new FakeSource();
    const { monitor } = makeMonitor(ds, { pollIntervalMs: 2000 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(6000);
    monitor.stop();
    expect(ds.reads).toEqual([0, 2000, 4000, 6000]);
  });

  it("raises one data source alert on errors, keeps polling, and resolves on recovery", async () => {
    const ds = new FakeSource();
    ds.fail = new DataSourceUnavailableError("unix:///var/run/docker.sock");
    const { monitor, events, snapshots } = makeMonitor(ds);
    monitor.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ds.reads).toEqual([0, 5000, 10_000]);
    expect(snapshots).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.raised).toHaveLength(1);
    expect(events[0]!.raised[0]!.ruleId).toBe("data_source_unavailable");
    expect(events[0]!.raised[0]!.measuredValue).toContain("unix:///var/run/docker.sock");

    ds.fail = undefined;
    await vi.advanceTimersByTimeAsync(5000);
    monitor.stop();
    expect(snapshots).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events[1]!.resolved.map((e) => e.ruleId)).toEqual(["data_source_unavailable"]);
  });

  it("forwards container alerts from the rule engine", async () => {
    const ds = new FakeSource();
    const { monitor, events } = makeMonitor(ds);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    ds.containers = [{ name: "plex", state: "exited", cpuPercent: 0, memoryBytes: 0 }];
    await vi.advanceTimersByTimeAsync(5000);
    monitor.stop();
    expect(events).toHaveLength(1);
    expect(events[0]!.raised.map((e) => e.key)).toEqual(["container_exited:container:plex"]);
  });

  it("reports a hung read as an error at the timeout and skips ticks until it settles", async () => {
    const ds = new FakeSource();
    ds.delayMs = 12_000; // hangs past the 5 s timeout
    const { monitor, events, snapshots } = makeMonitor(ds);
    monitor.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toHaveLength(1);
    expect(events[0]!.raised[0]!.ruleId).toBe("data_source_unavailable");
    expect(events[0]!.raised[0]!.measuredValue).toBe("Data source read timed out after 5000 ms");

    ds.delayMs = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    monitor.stop();
    // Ticks at 5 s and 10 s are skipped while the first read is in flight; 15 s reads again.
    expect(ds.reads).toEqual([0, 15_000]);
    // The late result of the timed-out read is ignored; only the 15 s read is evaluated.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.readAt).toBe(new Date(T0 + 15_000).toISOString());
    expect(events[1]!.resolved.map((e) => e.ruleId)).toEqual(["data_source_unavailable"]);
  });

  it("caps the read timeout at 10 s when the interval is longer", async () => {
    const ds = new FakeSource();
    ds.delayMs = 11_000;
    const { monitor, events } = makeMonitor(ds, { pollIntervalMs: 20_000 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(9999);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.raised[0]!.measuredValue).toBe("Data source read timed out after 10000 ms");
    await vi.advanceTimersByTimeAsync(10_000);
    monitor.stop();
    expect(ds.reads).toEqual([0, 20_000]);
  });

  it("keeps polling when callbacks throw or reject", async () => {
    const ds = new FakeSource();
    ds.fail = new Error("boom");
    const { monitor } = makeMonitor(ds, {
      onSnapshot: () => {
        throw new Error("snapshot callback failed");
      },
      onEvents: () => Promise.reject(new Error("events callback failed")),
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(5000);
    ds.fail = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    monitor.stop();
    expect(ds.reads).toEqual([0, 5000, 10_000, 15_000]);
    expect(monitor.latestSnapshot()).toBeDefined();
  });

  it("stops polling after stop()", async () => {
    const ds = new FakeSource();
    const { monitor } = makeMonitor(ds);
    monitor.start();
    monitor.start(); // second start is a no-op
    await vi.advanceTimersByTimeAsync(5000);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ds.reads).toEqual([0, 5000]);
  });
});
