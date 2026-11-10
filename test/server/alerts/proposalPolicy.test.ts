import { describe, expect, it } from "vitest";
import { proposalPolicy } from "../../../src/server/alerts/proposalPolicy.js";
import type { AlertEvent, AlertRuleId } from "../../../src/shared/types.js";

function containerEvent(ruleId: AlertRuleId, name = "plex"): AlertEvent {
  return {
    key: `${ruleId}:container:${name}`,
    ruleId,
    subject: { kind: "container", name },
    severity: "critical",
    measuredValue: "exited",
    detectedAt: "2025-10-31T23:00:00.000Z",
  };
}

describe("proposalPolicy", () => {
  it.each(["container_exited", "container_restarting"] as const)(
    "proposes restart for %s",
    (ruleId) => {
      const proposal = proposalPolicy(containerEvent(ruleId, "Nginx-Proxy_1"));

      expect(proposal).toMatchObject({
        action: "restart",
        container: "Nginx-Proxy_1",
        source: "alert",
      });
      expect(proposal?.reason.trim()).not.toBe("");
    },
  );

  it("proposes stop for a new high-CPU container", () => {
    const proposal = proposalPolicy(containerEvent("new_container_cpu", "unknown-process-x13"));

    expect(proposal).toMatchObject({
      action: "stop",
      container: "unknown-process-x13",
      source: "alert",
    });
    expect(proposal?.reason.trim()).not.toBe("");
  });

  it.each(["host_cpu", "host_memory", "disk", "data_source_unavailable"] as const)(
    "returns null for %s",
    (ruleId) => {
      expect(proposalPolicy(containerEvent(ruleId))).toBeNull();
    },
  );

  it("returns null when an actionable rule has no container subject", () => {
    expect(
      proposalPolicy({
        ...containerEvent("container_exited"),
        subject: { kind: "host", resource: "cpu" },
      }),
    ).toBeNull();
  });
});
