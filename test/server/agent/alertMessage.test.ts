import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "../../../src/server/actions/ProposalStore.js";
import { Agent, ALERT_MESSAGE_TIMEOUT_MS } from "../../../src/server/agent/Agent.js";
import { alertTemplate } from "../../../src/server/alerts/templates.js";
import { SimulatorSource } from "../../../src/server/datasource/simulator/SimulatorSource.js";
import { LlmClient, type LlmProvider, type LlmRequest } from "../../../src/server/llm/LlmClient.js";
import { createLogger } from "../../../src/server/logging/logger.js";
import { MessageStore } from "../../../src/server/messages/MessageStore.js";
import type { AlertEvent } from "../../../src/shared/types.js";

const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);
const event: AlertEvent = {
  key: "host_cpu:host:cpu",
  ruleId: "host_cpu",
  subject: { kind: "host", resource: "cpu" },
  severity: "warning",
  measuredValue: "97.3%",
  detectedAt: new Date(T0).toISOString(),
};

function setup(complete: LlmProvider["complete"]) {
  const logger = createLogger([], new Writable({ write: (_c, _e, cb) => cb() }));
  const clock = { now: () => T0 };
  const ds = new SimulatorSource(1, clock);
  const messages = new MessageStore();
  const proposals = new ProposalStore({ ds, clock });
  let n = 0;
  const agent = new Agent({
    ds,
    llm: new LlmClient({ complete }, logger),
    proposals,
    messages,
    clock,
    logger,
    newId: () => `m${++n}`,
  });
  return { agent, messages };
}

afterEach(() => vi.useRealTimers());

describe("Agent.writeAlertMessage", () => {
  it("uses accepted LLM text, sent as plain text with the subject and value", async () => {
    const requests: LlmRequest[] = [];
    const { agent } = setup(async (req) => {
      requests.push(req);
      return '"The host CPU smolders at 97.3%, a fever in the wires."';
    });
    await expect(agent.writeAlertMessage(event)).resolves.toBe("The host CPU smolders at 97.3%, a fever in the wires.");
    expect(requests[0]!.json).toBe(false);
    expect(requests[0]!.messages[0]!.content).toContain("host CPU");
    expect(requests[0]!.messages[0]!.content).toContain("97.3%");
  });

  it.each([
    ["missing value", "The host CPU is burning."],
    ["altered value", "The host CPU burns at 97%."],
    ["over 40 words", `The host CPU burns at 97.3% ${"and on ".repeat(20)}`],
  ])("falls back to the template for %s", async (_label, text) => {
    const { agent } = setup(async () => text);
    await expect(agent.writeAlertMessage(event)).resolves.toBe(alertTemplate(event));
  });

  it("falls back to the template on a provider error", async () => {
    const { agent } = setup(async () => Promise.reject(new Error("upstream")));
    await expect(agent.writeAlertMessage(event)).resolves.toBe(alertTemplate(event));
  });

  it("falls back to the template after the 10-second timeout", async () => {
    vi.useFakeTimers();
    const { agent } = setup(() => new Promise<string>(() => {}));
    const message = agent.writeAlertMessage(event);
    await vi.advanceTimersByTimeAsync(ALERT_MESSAGE_TIMEOUT_MS);
    await expect(message).resolves.toBe(alertTemplate(event));
  });
});

describe("Agent.reportActionResult", () => {
  const proposal = {
    id: "p1",
    action: "restart" as const,
    container: "plex",
    reason: "exited",
    createdAt: T0,
    status: "confirmed" as const,
    source: "alert" as const,
  };

  it("stores a success reply for speech", async () => {
    const { agent, messages } = setup(async () => "unused");
    const reply = await agent.reportActionResult(proposal, { ok: true });
    expect(reply.text).toContain("restart");
    expect(reply.text).toContain("plex");
    expect(messages.getText(reply.id)).toBe(reply.text);
  });

  it("keeps the Data_Source error verbatim", async () => {
    const { agent } = setup(async () => "unused");
    const reply = await agent.reportActionResult(proposal, { ok: false, error: "container is paused" });
    expect(reply.text).toContain("container is paused");
  });
});
