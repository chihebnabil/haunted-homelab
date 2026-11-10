import { describe, expect, it } from "vitest";
import { ActionExecutor } from "../../../src/server/actions/ActionExecutor.js";
import {
  ContainerNotFoundError,
  DataSourceActionError,
  DataSourceUnavailableError,
  type DataSource,
} from "../../../src/server/datasource/types.js";
import type { HostMetrics } from "../../../src/shared/types.js";

/** Minimal in-memory data source that records calls and can fail on demand. */
class RecordingSource implements DataSource {
  readonly kind = "simulator" as const;
  readonly calls: string[] = [];
  failWith: unknown;

  async listContainers() {
    return [];
  }
  async readLogs() {
    return [];
  }
  async readHostMetrics(): Promise<HostMetrics> {
    return { cpuPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, filesystems: [] };
  }
  async restart(name: string) {
    this.calls.push(`restart:${name}`);
    if (this.failWith !== undefined) throw this.failWith;
  }
  async stop(name: string) {
    this.calls.push(`stop:${name}`);
    if (this.failWith !== undefined) throw this.failWith;
  }
}

describe("ActionExecutor", () => {
  it("restart calls ds.restart only and reports success", async () => {
    const ds = new RecordingSource();
    const result = await new ActionExecutor(ds).run({ action: "restart", container: "plex" });
    expect(result).toEqual({ ok: true });
    expect(ds.calls).toEqual(["restart:plex"]);
  });

  it("stop calls ds.stop only and reports success", async () => {
    const ds = new RecordingSource();
    const result = await new ActionExecutor(ds).run({ action: "stop", container: "pihole" });
    expect(result).toEqual({ ok: true });
    expect(ds.calls).toEqual(["stop:pihole"]);
  });

  it.each([
    ["action error", new DataSourceActionError("container already stopped"), "container already stopped"],
    ["not found", new ContainerNotFoundError("ghost"), "Container not found: ghost"],
    [
      "unavailable",
      new DataSourceUnavailableError("unix:///var/run/docker.sock"),
      "Data source unavailable at unix:///var/run/docker.sock",
    ],
    ["plain string", "boom", "boom"],
    ["empty Error message", new Error(""), "Error"],
    ["non-error value", { code: 1 }, "Unknown error"],
  ])("maps %s to { ok: false, error } without throwing", async (_label, thrown, expected) => {
    const ds = new RecordingSource();
    ds.failWith = thrown;
    const result = await new ActionExecutor(ds).run({ action: "restart", container: "plex" });
    expect(result).toEqual({ ok: false, error: expected });
  });
});
