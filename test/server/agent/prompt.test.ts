import { describe, expect, it } from "vitest";
import { factLines, type FactSheet } from "../../../src/server/agent/factSheet.js";
import { PERSONA_SYSTEM_PROMPT } from "../../../src/server/agent/persona.js";
import { buildChatPrompt } from "../../../src/server/agent/prompt.js";
import type { ChatTurn, LogLine } from "../../../src/shared/types.js";

const facts: FactSheet = {
  host: {
    cpu: "17.4%",
    memory: "31.3%",
    memoryUsed: "10.0 GiB",
    memoryTotal: "32.0 GiB",
    disks: [{ mount: "/", used: "40.0%" }],
  },
  containers: [
    { name: "plex", state: "running", cpu: "12.3%", memory: "512.0 MiB" },
  ],
};

function line(index: number, text = `line-${index}`): LogLine {
  const timestamp = new Date(Date.UTC(2025, 9, 31, 0, index)).toISOString();
  return { timestamp, text };
}

describe("PERSONA_SYSTEM_PROMPT", () => {
  it("defines the persona, factual limits, proposal limits, and JSON response shape", () => {
    expect(PERSONA_SYSTEM_PROMPT).toMatch(/ghost in the machine/i);
    expect(PERSONA_SYSTEM_PROMPT).toMatch(/spooky metaphors/i);
    expect(PERSONA_SYSTEM_PROMPT).toMatch(/exactly as written/i);
    expect(PERSONA_SYSTEM_PROMPT).toMatch(/120 words or fewer/i);
    expect(PERSONA_SYSTEM_PROMPT).toContain('"action": "restart" | "stop"');
    expect(PERSONA_SYSTEM_PROMPT).toMatch(/only for a container listed in FACTS/i);
    expect(PERSONA_SYSTEM_PROMPT).toContain('"reply"');
    expect(PERSONA_SYSTEM_PROMPT).toContain('"mentionedContainer"');
    expect(PERSONA_SYSTEM_PROMPT).toContain('"proposal"');
  });
});

describe("buildChatPrompt", () => {
  it("builds a JSON request with FACTS then QUESTION", () => {
    const request = buildChatPrompt({
      question: "What haunts plex?",
      history: [],
      facts,
      intent: "chat",
    });

    expect(request.system).toBe(PERSONA_SYSTEM_PROMPT);
    expect(request.json).toBe(true);
    expect(request.maxTokens).toBeGreaterThan(0);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: `FACTS\n${factLines(facts).join("\n")}\n\nQUESTION\nWhat haunts plex?`,
      },
    ]);
  });

  it("keeps the last 10 history turns, truncates each, and maps ghost to assistant", () => {
    const history: ChatTurn[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "ghost",
      text: `${index}:` + "x".repeat(2_100),
    }));

    const request = buildChatPrompt({ question: "Now?", history, facts, intent: "chat" });
    const retained = request.messages.slice(0, -1);

    expect(retained).toHaveLength(10);
    expect(retained[0]).toEqual({ role: "user", content: history[2]!.text.slice(0, 2_000) });
    expect(retained[1]).toEqual({ role: "assistant", content: history[3]!.text.slice(0, 2_000) });
    expect(retained.at(-1)).toEqual({
      role: "assistant",
      content: history[11]!.text.slice(0, 2_000),
    });
    expect(retained.every((message) => message.content.length <= 2_000)).toBe(true);
  });

  it("includes only the last configured log lines in original order", () => {
    const lines = Array.from({ length: 105 }, (_, index) => line(index));
    const original = [...lines];
    const request = buildChatPrompt({
      question: "Read the traces.",
      history: [],
      facts,
      logs: { container: "plex", lines, limit: 100 },
      intent: "chat",
    });
    const content = request.messages[0]!.content;

    expect(content.indexOf("FACTS\n")).toBeLessThan(content.indexOf("LOGS plex\n"));
    expect(content.indexOf("LOGS plex\n")).toBeLessThan(content.indexOf("QUESTION\n"));
    expect(content).not.toContain(`${lines[4]!.timestamp} line-4`);
    expect(content).toContain(`${lines[5]!.timestamp} line-5`);
    expect(content.indexOf(`${lines[5]!.timestamp} line-5`)).toBeLessThan(
      content.indexOf(`${lines[104]!.timestamp} line-104`),
    );
    expect(content).not.toContain("LOG EVENTS");
    expect(lines).toEqual(original);
  });

  it("places summary log events after logs and derives them from the selected tail", () => {
    const lines = [
      line(0, "ERROR: excluded old failure"),
      line(1, "routine heartbeat"),
      line(2, "WARN: selected warning"),
      line(3, "FATAL: selected failure"),
    ];
    const request = buildChatPrompt({
      question: "Summarize plex logs.",
      history: [],
      facts,
      logs: { container: "plex", lines, limit: 100 },
      intent: "summarize",
    });
    const content = request.messages[0]!.content;
    const factsAt = content.indexOf("FACTS\n");
    const logsAt = content.indexOf("LOGS plex\n");
    const eventsAt = content.indexOf("LOG EVENTS\n");
    const questionAt = content.indexOf("QUESTION\n");

    expect(factsAt).toBeLessThan(logsAt);
    expect(logsAt).toBeLessThan(eventsAt);
    expect(eventsAt).toBeLessThan(questionAt);
    expect(content).toContain(`${lines[2]!.timestamp} warning WARN: selected warning`);
    expect(content).toContain(`${lines[3]!.timestamp} error FATAL: selected failure`);
  });

  it("applies the 200-line summary limit to logs and log events", () => {
    const lines = Array.from({ length: 201 }, (_, index) =>
      line(index, index === 0 ? "ERROR: excluded" : `WARN: event-${index}`),
    );
    const request = buildChatPrompt({
      question: "Summary?",
      history: [],
      facts,
      logs: { container: "plex", lines, limit: 200 },
      intent: "summarize",
    });
    const content = request.messages[0]!.content;

    expect(content).not.toContain("ERROR: excluded");
    expect(content).toContain("WARN: event-1");
    expect(content).toContain("WARN: event-200");
  });

  it("adds an empty LOG EVENTS section for a summary without supplied logs", () => {
    const request = buildChatPrompt({
      question: "Summarize the silence.",
      history: [],
      facts,
      intent: "summarize",
    });

    expect(request.messages[0]!.content).toBe(
      `FACTS\n${factLines(facts).join("\n")}\n\nLOG EVENTS\n\n\nQUESTION\nSummarize the silence.`,
    );
  });

  it("ignores extra configuration-shaped input fields", () => {
    const request = buildChatPrompt({
      question: "Status?",
      history: [],
      facts,
      intent: "chat",
      apiKey: "sk-secret-must-not-leak",
      dockerEndpoint: "tcp://private-daemon:2375",
    } as Parameters<typeof buildChatPrompt>[0] & {
      apiKey: string;
      dockerEndpoint: string;
    });
    const serialized = JSON.stringify(request);

    expect(serialized).not.toContain("sk-secret-must-not-leak");
    expect(serialized).not.toContain("tcp://private-daemon:2375");
  });
});
