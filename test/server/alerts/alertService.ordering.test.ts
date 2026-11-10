import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AlertService } from "../../../src/server/alerts/AlertService.js";
import { createLogger } from "../../../src/server/logging/logger.js";
import { MessageStore } from "../../../src/server/messages/MessageStore.js";
import type { ActionProposalDTO, AlertEvent, ServerEvent } from "../../../src/shared/types.js";

const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);

function event(ruleId: AlertEvent["ruleId"], name = "plex"): AlertEvent {
  return {
    key: `${ruleId}:container:${name}`,
    ruleId,
    subject: { kind: "container", name },
    severity: "critical",
    measuredValue: "exited",
    detectedAt: new Date(T0).toISOString(),
  };
}

function setup() {
  const events: ServerEvent[] = [];
  const messages = new MessageStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const created: string[] = [];
  const service = new AlertService({
    agent: {
      writeAlertMessage: async (e) => {
        await gate; // the Agent is slow: resolved must still wait for raised
        return `The spirit of ${e.subject.kind === "container" ? e.subject.name : "?"} lies exited.`;
      },
    },
    proposals: {
      create: (p) => {
        created.push(`${p.action}:${p.container}:${p.source}`);
        const dto: ActionProposalDTO = {
          id: `p${created.length}`,
          action: p.action,
          container: p.container,
          reason: p.reason,
          createdAt: new Date(T0).toISOString(),
          expiresAt: new Date(T0 + 300_000).toISOString(),
          status: "pending",
        };
        return dto;
      },
    },
    hub: { broadcast: (e) => events.push(e) },
    messages,
    clock: { now: () => T0 + 5000 },
    logger: createLogger([], new Writable({ write: (_c, _e, cb) => cb() })),
    newId: () => `id${++n}`,
  });
  return { service, events, messages, created, release };
}

describe("AlertService", () => {
  it("never lets a resolved event overtake its raised event", async () => {
    const { service, events, messages, release } = setup();
    const e = event("container_exited");
    service.handle([e], []);
    service.handle([], [e]);
    release();
    await service.idle();

    expect(events.map((x) => x.type)).toEqual(["alert.raised", "alert.resolved"]);
    const raised = events[0] as Extract<ServerEvent, { type: "alert.raised" }>;
    const resolved = events[1] as Extract<ServerEvent, { type: "alert.resolved" }>;
    expect(resolved.alertId).toBe(raised.alert.id);
    expect(messages.getText(raised.alert.id)).toBe(raised.alert.message);
    expect(messages.getText(resolved.recoveryMessageId)).toBe(resolved.recoveryMessage);
    expect(resolved.recoveryMessage).toContain("plex");
    expect(service.activeAlerts()).toEqual([]);
    expect(service.recentAlerts()[0]).toMatchObject({ status: "resolved", resolvedAt: new Date(T0 + 5000).toISOString() });
  });

  it("attaches alert proposals for actionable container alerts only", async () => {
    const { service, events, created, release } = setup();
    release();
    service.handle([event("container_exited"), { ...event("host_cpu"), key: "host_cpu:host:cpu", subject: { kind: "host", resource: "cpu" }, measuredValue: "97.3%" }], []);
    await service.idle();

    expect(created).toEqual(["restart:plex:alert"]);
    const raised = events.filter((x): x is Extract<ServerEvent, { type: "alert.raised" }> => x.type === "alert.raised");
    expect(raised).toHaveLength(2);
    expect(raised[0]!.proposal?.id).toBe("p1");
    expect(raised[0]!.alert.proposalId).toBe("p1");
    expect(raised[1]!.proposal).toBeUndefined();
    expect(service.activeAlerts()).toHaveLength(2);
  });
});
