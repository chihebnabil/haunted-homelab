import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../src/shared/types.js";
import { validateProposal } from "../../../src/server/agent/validateProposal.js";

const snapshot: Snapshot = {
  readAt: "2025-10-31T23:59:00.000Z",
  containers: [
    { name: "plex", state: "running", cpuPercent: 12.3, memoryBytes: 512 },
    { name: "pihole", state: "exited", cpuPercent: 0, memoryBytes: 0 },
  ],
  host: {
    cpuPercent: 20,
    memoryUsedBytes: 4_000,
    memoryTotalBytes: 8_000,
    filesystems: [],
  },
};

describe("validateProposal", () => {
  it.each(["restart", "stop"] as const)("accepts %s for an existing container", (action) => {
    expect(validateProposal({ action, container: "plex", reason: "Recover the service" }, snapshot)).toEqual({
      action,
      container: "plex",
      reason: "Recover the service",
    });
  });

  it("accepts any existing container state and strips unrelated fields", () => {
    expect(
      validateProposal(
        {
          action: "restart",
          container: "pihole",
          reason: "Restore the resolver",
          unsupported: "ignored",
        },
        snapshot,
      ),
    ).toEqual({ action: "restart", container: "pihole", reason: "Restore the resolver" });
  });

  it.each([
    { action: "delete", container: "plex", reason: "Unsupported action" },
    { action: "Restart", container: "plex", reason: "Wrong casing" },
    { action: "restart", container: "unknown", reason: "Unknown target" },
    { action: "restart", container: "PLEX", reason: "Target must match exactly" },
    { action: "restart", container: "plex", reason: "" },
    { action: "restart", container: "plex", reason: " \t\n " },
  ])("rejects unsupported or unsafe proposal %#", (proposal) => {
    expect(validateProposal(proposal, snapshot)).toBeNull();
  });

  it.each([
    null,
    undefined,
    "restart plex",
    42,
    [],
    {},
    { action: "restart" },
    { action: "restart", container: "plex", reason: 123 },
  ])("returns null without throwing for malformed input %#", (input) => {
    expect(() => validateProposal(input, snapshot)).not.toThrow();
    expect(validateProposal(input, snapshot)).toBeNull();
  });
});
