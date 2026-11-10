import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../src/shared/types.js";
import { buildFactSheet, factLines } from "../../../src/server/agent/factSheet.js";
import {
  allowedQuantities,
  extractQuantities,
  factGuard,
} from "../../../src/server/agent/factGuard.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const snapshot: Snapshot = {
  readAt: "2025-10-31T23:59:00.000Z",
  containers: [
    { name: "plex", state: "running", cpuPercent: 12.34, memoryBytes: 512 * MiB },
    { name: "pihole", state: "exited", cpuPercent: 0, memoryBytes: 0 },
  ],
  host: {
    cpuPercent: 97.345,
    memoryUsedBytes: 10 * GiB,
    memoryTotalBytes: 32 * GiB,
    filesystems: [
      { mount: "/", usedBytes: 97, totalBytes: 100 },
      { mount: "/mnt/media", usedBytes: 0, totalBytes: 0 },
    ],
  },
};

describe("buildFactSheet", () => {
  it("formats every value with the shared formatters", () => {
    expect(buildFactSheet(snapshot)).toEqual({
      host: {
        cpu: "97.3%",
        memory: "31.3%",
        memoryUsed: "10.0 GiB",
        memoryTotal: "32.0 GiB",
        disks: [
          { mount: "/", used: "97.0%" },
          { mount: "/mnt/media", used: "0.0%" },
        ],
      },
      containers: [
        { name: "plex", state: "running", cpu: "12.3%", memory: "512.0 MiB" },
        { name: "pihole", state: "exited", cpu: "0.0%", memory: "0.0 B" },
      ],
    });
  });

  it("renders one line per fact", () => {
    expect(factLines(buildFactSheet(snapshot))).toEqual([
      "host CPU: 97.3%",
      "host memory: 31.3% (10.0 GiB of 32.0 GiB)",
      "filesystem /: 97.0% used",
      "filesystem /mnt/media: 0.0% used",
      "container plex: running, CPU 12.3%, memory 512.0 MiB",
      "container pihole: exited, CPU 0.0%, memory 0.0 B",
    ]);
  });
});

describe("extractQuantities", () => {
  it("finds percent and byte quantities with or without whitespace", () => {
    expect(
      extractQuantities("CPU at 97.3% and 12 %, memory 512.0 MiB, 1.5GiB, 3 GB, 2048 bytes"),
    ).toEqual(["97.3%", "12%", "512.0mib", "1.5gib", "3gb", "2048bytes"]);
  });

  it("ignores plain numbers, bare B, and unit-like words", () => {
    expect(extractQuantities("port 32400, 3 containers, 0.0 B, 5 MBps, 7 Bytesize")).toEqual([]);
  });
});

describe("factGuard", () => {
  const facts = buildFactSheet(snapshot);
  const allowed = allowedQuantities(facts, ["Is plex using more than 50%?", "2025 ok 4.2 GB written"]);

  it("accepts replies that quote facts, the question, and logs exactly", () => {
    const reply =
      "The host CPU burns at 97.3 %, plex hoards 512.0MiB of 32.0 GiB. Not above 50%. Logs whisper of 4.2 GB.";
    expect(factGuard(reply, allowed)).toEqual({ ok: true });
  });

  it("accepts replies without quantities", () => {
    expect(factGuard("All spirits rest quietly.", allowed)).toEqual({ ok: true });
  });

  it("rejects invented or altered quantities, listing each once", () => {
    const reply = "CPU at 97.4%, then 97%, plex at 12.30% and 600 MiB, again 97.4%.";
    expect(factGuard(reply, allowed)).toEqual({
      ok: false,
      invalid: ["97.4%", "97%", "12.30%", "600mib"],
    });
  });
});
