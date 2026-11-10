import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerInfo,
  HostMetrics,
  LogLine,
} from "../../../src/shared/types.js";
import { Agent } from "../../../src/server/agent/Agent.js";
import { factTemplateReply, noLogsTemplate } from "../../../src/server/agent/replyTemplates.js";
import { ProposalStore } from "../../../src/server/actions/ProposalStore.js";
import type { DataSource } from "../../../src/server/datasource/types.js";
import {
  LlmClient,
  LlmProviderError,
  LlmTimeoutError,
  type LlmProvider,
  type LlmRequest,
} from "../../../src/server/llm/LlmClient.js";
import { createLogger } from "../../../src/server/logging/logger.js";
import { MessageStore } from "../../../src/server/messages/MessageStore.js";

const T0 = Date.UTC(2025, 9, 31, 23, 59, 0);
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const containers: ContainerInfo[] = [
  { name: "plex", state: "running", cpuPercent: 12.3, memoryBytes: 512 * MiB },
  { name: "pihole", state: "running", cpuPercent: 3.1, memoryBytes: 256 * MiB },
];

const host: HostMetrics = {
  cpuPercent: 25,
  memoryUsedBytes: 16 * GiB,
  memoryTotalBytes: 32 * GiB,
  filesystems: [{ mount: "/", usedBytes: 40, totalBytes: 100 }],
};

class FakeSource implements DataSource {
  readonly kind = "simulator" as const;
  readonly logCalls: { name: string; maxLines: number }[] = [];
  readonly logs = new Map<string, LogLine[]>();

  async listContainers() {
    return containers;
  }

  async readLogs(name: string, maxLines: number) {
    this.logCalls.push({ name, maxLines });
    return this.logs.get(name) ?? [];
  }

  async readHostMetrics() {
    return host;
  }

  async restart() {}
  async stop() {}
}

function quietLogger() {
  return createLogger([], new Writable({ write: (_chunk, _encoding, callback) => callback() }));
}

function json(
  reply: string,
  mentionedContainer: string | null = null,
  proposal: unknown = null,
): string {
  return JSON.stringify({ reply, mentionedContainer, proposal });
}

function setup(outputs: Array<string | Error> = []) {
  const ds = new FakeSource();
  const requests: LlmRequest[] = [];
  let now = T0;
  const provider: LlmProvider = {
    complete: async (request) => {
      requests.push(request);
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error("No queued LLM output");
      return output;
    },
  };
  const logger = quietLogger();
  const llm = new LlmClient(provider, logger);
  const messages = new MessageStore();
  let proposalId = 0;
  let messageId = 0;
  const clock = { now: () => now };
  const proposals = new ProposalStore({
    ds,
    clock,
    newId: () => `proposal-${++proposalId}`,
  });
  const agent = new Agent({
    ds,
    llm,
    proposals,
    messages,
    clock,
    logger,
    newId: () => `message-${++messageId}`,
  });
  return {
    agent,
    ds,
    llm,
    messages,
    proposals,
    requests,
    advance: (ms: number) => (now += ms),
    deadline: () => now + 30_000,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Agent.answer", () => {
  it("asks which container for an unscoped summary without calling the LLM", async () => {
    const { agent, messages, requests, deadline } = setup();

    const reply = await agent.answer("Summarize the logs", [], deadline());

    expect(reply.text).toMatch(/Which container/i);
    expect(reply.text).toContain("plex");
    expect(reply.text).toContain("pihole");
    expect(requests).toHaveLength(0);
    expect(messages.getText(reply.id)).toBe(reply.text);
  });

  it("returns the no-logs template without an LLM call and requests 200 summary lines", async () => {
    const { agent, ds, messages, requests, deadline } = setup();

    const reply = await agent.answer("Summarize plex logs", [], deadline());

    expect(reply.text).toBe(noLogsTemplate("plex"));
    expect(ds.logCalls).toEqual([{ name: "plex", maxLines: 200 }]);
    expect(requests).toHaveLength(0);
    expect(messages.getText(reply.id)).toBe(reply.text);
  });

  it("uses non-JSON output as plain text, limits it, and stores it", async () => {
    const raw = Array.from({ length: 130 }, (_, index) => `word${index}`).join(" ");
    const { agent, ds, messages, deadline } = setup([raw]);
    ds.logs.set("plex", [{ timestamp: "2025-10-31T23:58:00.000Z", text: "routine" }]);

    const reply = await agent.answer("How is plex?", [], deadline());

    expect(reply.text.split(/\s+/)).toHaveLength(120);
    expect(reply.text).toBe(raw.split(/\s+/).slice(0, 120).join(" "));
    expect(ds.logCalls).toEqual([{ name: "plex", maxLines: 100 }]);
    expect(messages.getText(reply.id)).toBe(reply.text);
  });

  it("returns the deterministic unknown-container reply", async () => {
    const { agent, proposals, deadline } = setup([
      json("A lost vessel stirs.", "jellyfin", {
        action: "restart",
        container: "plex",
        reason: "unrelated",
      }),
    ]);

    const reply = await agent.answer("Is jellyfin alive?", [], deadline());

    expect(reply.text).toContain("jellyfin");
    expect(reply.text).toContain("plex");
    expect(reply.text).toContain("pihole");
    expect(reply.proposal).toBeUndefined();
    expect(proposals.list()).toEqual([]);
  });

  it("re-requests once with logs for a known container reported by the LLM", async () => {
    const { agent, ds, requests, deadline } = setup([
      json("I should inspect plex.", "plex"),
      json("The plex vessel hums normally.", "plex"),
    ]);
    const line = { timestamp: "2025-10-31T23:58:00.000Z", text: "routine heartbeat" };
    ds.logs.set("plex", [line]);

    const reply = await agent.answer("What is happening?", [], deadline());

    expect(reply.text).toBe("The plex vessel hums normally.");
    expect(ds.logCalls).toEqual([{ name: "plex", maxLines: 100 }]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain(`LOGS plex\n${line.timestamp} ${line.text}`);
  });

  it("shares one deadline across a corrective retry and falls back after a second violation", async () => {
    const { agent, llm, advance, deadline } = setup([
      json("The host now burns at 88.8%."),
    ]);
    const complete = vi.spyOn(llm, "complete");
    complete.mockImplementationOnce(async function (_request, _timeoutMs) {
      advance(5_000);
      return json("The host burns at 99.9%.");
    });

    const reply = await agent.answer("How is the host?", [], deadline());

    const snapshot = { readAt: new Date(T0).toISOString(), containers, host };
    expect(reply.text).toBe(factTemplateReply(snapshot, []));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![1]).toBe(30_000);
    expect(complete.mock.calls[1]![1]).toBe(25_000);
    expect(complete.mock.calls[1]![0].messages.at(-1)!.content).toContain("99.9%");
  });

  it("extracts summary events and registers only a valid proposal", async () => {
    const { agent, ds, proposals, deadline } = setup([
      json("The plex vessel asks for a restart.", "plex", {
        action: "restart",
        container: "plex",
        reason: "Recover the worker",
      }),
    ]);
    ds.logs.set("plex", [
      { timestamp: "2025-10-31T23:57:00.000Z", text: "routine heartbeat" },
      { timestamp: "2025-10-31T23:58:00.000Z", text: "WARN: queue is slow" },
      { timestamp: "2025-10-31T23:59:00.000Z", text: "FATAL: worker failed" },
    ]);

    const reply = await agent.answer("Summarize plex logs", [], deadline());

    expect(reply.events).toEqual([
      { timestamp: "2025-10-31T23:58:00.000Z", level: "warning", text: "WARN: queue is slow" },
      { timestamp: "2025-10-31T23:59:00.000Z", level: "error", text: "FATAL: worker failed" },
    ]);
    expect(reply.proposal).toMatchObject({
      id: "proposal-1",
      action: "restart",
      container: "plex",
      status: "pending",
    });
    expect(proposals.list()).toEqual([reply.proposal]);
  });

  it("drops an invalid proposal without discarding its valid reply text", async () => {
    const { agent, proposals, deadline } = setup([
      json("The plex vessel remains steady.", "plex", {
        action: "delete",
        container: "plex",
        reason: "unsupported",
      }),
    ]);

    const reply = await agent.answer("How is plex?", [], deadline());

    expect(reply.text).toBe("The plex vessel remains steady.");
    expect(reply.proposal).toBeUndefined();
    expect(proposals.list()).toEqual([]);
  });

  it("preserves typed provider errors and stores no failed reply", async () => {
    const { agent, messages, deadline } = setup([new Error("upstream broke")]);

    await expect(agent.answer("Status?", [], deadline())).rejects.toBeInstanceOf(LlmProviderError);
    expect(messages.size).toBe(0);
  });

  it("enforces the 30-second overall cap and preserves LlmTimeoutError", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const ds = new FakeSource();
    const logger = quietLogger();
    const provider: LlmProvider = {
      complete: (_request, providerSignal) => {
        signal = providerSignal;
        return new Promise<string>(() => {});
      },
    };
    const llm = new LlmClient(provider, logger);
    const messages = new MessageStore();
    const clock = { now: () => T0 };
    const proposals = new ProposalStore({ ds, clock });
    const agent = new Agent({ ds, llm, proposals, messages, clock, logger });

    const answer = agent.answer("Status?", [], T0 + 60_000);
    const rejection = expect(answer).rejects.toBeInstanceOf(LlmTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    expect(signal?.aborted).toBe(true);
    expect(messages.size).toBe(0);
  });
});
