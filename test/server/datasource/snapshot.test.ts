import { describe, expect, it } from "vitest";
import type { ContainerInfo, HostMetrics, LogLine } from "../../../src/shared/types.js";
import { readSnapshot } from "../../../src/server/datasource/snapshot.js";
import {
  ContainerNotFoundError,
  DataSourceActionError,
  DataSourceUnavailableError,
  type DataSource,
} from "../../../src/server/datasource/types.js";

const containers: ContainerInfo[] = [
  { name: "plex", state: "running", cpuPercent: 12.5, memoryBytes: 512 * 1024 * 1024 },
  { name: "pihole", state: "exited", cpuPercent: 0, memoryBytes: 0 },
];

const host: HostMetrics = {
  cpuPercent: 20,
  memoryUsedBytes: 8 * 1024 ** 3,
  memoryTotalBytes: 32 * 1024 ** 3,
  filesystems: [{ mount: "/", usedBytes: 100, totalBytes: 1000 }],
};

/** In-memory data source that records whether both reads were in flight at once. */
function fakeSource(opts: { failHost?: Error } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async <T>(value: () => T): Promise<T> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return value();
  };
  const ds: DataSource = {
    kind: "simulator",
    listContainers: () => track(() => containers),
    readHostMetrics: () =>
      track(() => {
        if (opts.failHost) throw opts.failHost;
        return host;
      }),
    readLogs: async (): Promise<LogLine[]> => [],
    restart: async () => {},
    stop: async () => {},
  };
  return { ds, maxInFlight: () => maxInFlight };
}

describe("readSnapshot", () => {
  it("returns containers and host metrics stamped with the clock time", async () => {
    const { ds, maxInFlight } = fakeSource();
    const now = Date.UTC(2025, 9, 31, 23, 59, 0);
    const snapshot = await readSnapshot(ds, { now: () => now });

    expect(snapshot).toEqual({ readAt: "2025-10-31T23:59:00.000Z", containers, host });
    expect(maxInFlight()).toBe(2);
  });

  it("rejects with the data source error", async () => {
    const err = new DataSourceUnavailableError("unix:///var/run/docker.sock");
    const { ds } = fakeSource({ failHost: err });
    await expect(readSnapshot(ds, { now: () => 0 })).rejects.toBe(err);
  });
});

describe("data source errors", () => {
  it("DataSourceUnavailableError names the endpoint and keeps the cause", () => {
    const cause = new Error("connect ECONNREFUSED");
    const err = new DataSourceUnavailableError("tcp://10.0.0.5:2375", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DataSourceUnavailableError");
    expect(err.endpoint).toBe("tcp://10.0.0.5:2375");
    expect(err.message).toContain("tcp://10.0.0.5:2375");
    expect(err.cause).toBe(cause);
  });

  it("ContainerNotFoundError includes the requested name", () => {
    const err = new ContainerNotFoundError("plexx");
    expect(err.containerName).toBe("plexx");
    expect(err.message).toContain("plexx");
    expect(err).toBeInstanceOf(ContainerNotFoundError);
  });

  it("DataSourceActionError keeps the data source message verbatim", () => {
    const err = new DataSourceActionError("container already stopped");
    expect(err.message).toBe("container already stopped");
    expect(err.name).toBe("DataSourceActionError");
  });
});
