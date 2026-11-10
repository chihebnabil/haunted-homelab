import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/server/config/loadConfig.js";
import { createDataSource } from "../../../src/server/datasource/factory.js";
import { SimulatorSource } from "../../../src/server/datasource/simulator/SimulatorSource.js";
import { createLogger } from "../../../src/server/logging/logger.js";

const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);

function config(dataSource: "simulator" | "docker") {
  return loadConfig(
    {
      HAUNTED_OPENROUTER_API_KEY: "test-key",
      HAUNTED_DATA_SOURCE: dataSource,
      HAUNTED_SIM_SEED: "42",
    },
    undefined,
    { platform: "linux" },
  );
}

describe("SimulatorSource", () => {
  it("adapts reads, incidents, and container operations while retaining state", async () => {
    let now = T0;
    const source = new SimulatorSource(42, { now: () => now });

    expect(source.kind).toBe("simulator");
    expect((await source.listContainers()).map((container) => container.name)).toContain("plex");

    source.stage("container_crash", "plex");
    expect(source.listIncidents()).toEqual([{ type: "container_crash", target: "plex", stagedAt: T0 }]);
    expect((await source.listContainers()).find((container) => container.name === "plex")?.state).toBe("exited");
    expect(await source.readLogs("plex", 3)).toHaveLength(3);

    now += 5_000;
    await source.restart("plex");
    expect(source.listIncidents()).toEqual([]);
    expect((await source.listContainers()).find((container) => container.name === "plex")?.state).toBe("running");

    await source.stop("plex");
    expect((await source.listContainers()).find((container) => container.name === "plex")?.state).toBe("exited");
    expect(source.clearAll()).toEqual([]);
    expect((await source.listContainers()).find((container) => container.name === "plex")?.state).toBe("running");
  });

  it("does not expose mutable incident state", () => {
    const source = new SimulatorSource(42, { now: () => T0 });
    source.stage("memory_leak", "pihole");

    const incidents = source.listIncidents();
    incidents[0]!.leakBytes = 123;
    incidents.push({ type: "disk_full", stagedAt: T0 });

    expect(source.listIncidents()).toEqual([
      { type: "memory_leak", target: "pihole", stagedAt: T0, leakBytes: 0 },
    ]);
  });
});

describe("createDataSource", () => {
  const clock = { now: () => T0 };
  const logger = createLogger([]);

  it("returns a SimulatorSource configured with the simulator seed", async () => {
    const source = createDataSource(config("simulator"), clock, logger);
    const direct = new SimulatorSource(42, clock);

    expect(source).toBeInstanceOf(SimulatorSource);
    expect(await source.listContainers()).toEqual(await direct.listContainers());
  });

  it("throws the documented startup error for docker mode", () => {
    expect(() => createDataSource(config("docker"), clock, logger)).toThrow(
      "Docker data source is not built yet. Set HAUNTED_DATA_SOURCE=simulator.",
    );
  });
});
