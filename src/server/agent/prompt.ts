import type { ChatTurn, LogLine } from "../../shared/types.js";
import type { LlmRequest } from "../llm/LlmClient.js";
import { factLines, type FactSheet } from "./factSheet.js";
import { extractLogEvents } from "./logEvents.js";
import { PERSONA_SYSTEM_PROMPT } from "./persona.js";

const HISTORY_LIMIT = 10;
const HISTORY_TURN_CHARACTER_LIMIT = 2_000;
const MAX_RESPONSE_TOKENS = 300;

export interface ChatPromptInput {
  question: string;
  history: readonly ChatTurn[];
  facts: FactSheet;
  logs?: {
    container: string;
    lines: readonly LogLine[];
    limit: 100 | 200;
  };
  intent: "chat" | "summarize";
}

/** Builds the provider-neutral chat request without accepting configuration or environment data. */
export function buildChatPrompt(input: ChatPromptInput): LlmRequest {
  const messages: LlmRequest["messages"] = input.history.slice(-HISTORY_LIMIT).map((turn) => ({
    role: turn.role === "ghost" ? "assistant" : "user",
    content: turn.text.slice(0, HISTORY_TURN_CHARACTER_LIMIT),
  }));

  const sections = [`FACTS\n${factLines(input.facts).join("\n")}`];
  const selectedLogs = input.logs?.lines.slice(-input.logs.limit) ?? [];

  if (input.logs !== undefined) {
    const renderedLogs = selectedLogs.map((line) => `${line.timestamp} ${line.text}`);
    sections.push(`LOGS ${input.logs.container}\n${renderedLogs.join("\n")}`);
  }

  if (input.intent === "summarize") {
    const renderedEvents = extractLogEvents(selectedLogs).map(
      (event) => `${event.timestamp} ${event.level} ${event.text}`,
    );
    sections.push(`LOG EVENTS\n${renderedEvents.join("\n")}`);
  }

  sections.push(`QUESTION\n${input.question}`);
  messages.push({ role: "user", content: sections.join("\n\n") });

  return {
    system: PERSONA_SYSTEM_PROMPT,
    messages,
    maxTokens: MAX_RESPONSE_TOKENS,
    json: true,
  };
}
