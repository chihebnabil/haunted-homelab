import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ActionProposalDTO,
  AlertEvent,
  ChatTurn,
  Clock,
  GhostReply,
  LogEvent,
  LogLine,
  Snapshot,
} from "../../shared/types.js";
import { countWords, limitWords } from "../../shared/words.js";
import { ProposalStore } from "../actions/ProposalStore.js";
import type { ActionProposal, ActionResult } from "../actions/types.js";
import { acceptAlertText, alertTemplate, subjectLabel } from "../alerts/templates.js";
import { readSnapshot } from "../datasource/snapshot.js";
import { ContainerNotFoundError, type DataSource } from "../datasource/types.js";
import type { LlmClient, LlmRequest } from "../llm/LlmClient.js";
import type { Logger } from "../logging/logger.js";
import type { MessageStore } from "../messages/MessageStore.js";
import { allowedQuantities, factGuard } from "./factGuard.js";
import { buildFactSheet, type FactSheet } from "./factSheet.js";
import { extractLogEvents } from "./logEvents.js";
import { detectIntent, findContainer, resolveContainerMentions, type Intent } from "./mentions.js";
import { buildChatPrompt } from "./prompt.js";
import {
  actionResultReply,
  factTemplateReply,
  noLogsTemplate,
  unknownContainerReply,
  type ListedReply,
} from "./replyTemplates.js";
import { validateProposal } from "./validateProposal.js";

const MAX_ANSWER_MS = 30_000;
const MAX_REPLY_WORDS = 120;
/** Timeout for the one LLM call that writes an alert message (Requirement 5.5). */
export const ALERT_MESSAGE_TIMEOUT_MS = 10_000;

const ALERT_SYSTEM_PROMPT =
  "You are the ghost in the machine haunting a homelab. Write exactly one eerie sentence of at most 40 words " +
  "announcing the alert. Quote the subject and the measured value exactly as given. " +
  "Reply with the sentence only: no JSON, no quotes, no Markdown.";

const CompletionSchema = z.object({
  reply: z.string(),
  mentionedContainer: z.string().nullable(),
  proposal: z.union([z.record(z.string(), z.unknown()), z.null()]),
});

type ParsedCompletion = z.infer<typeof CompletionSchema>;

interface IncludedLogs {
  container: string;
  lines: LogLine[];
  limit: 100 | 200;
}

export interface AgentDeps {
  ds: DataSource;
  llm: LlmClient;
  proposals: ProposalStore;
  messages: MessageStore;
  clock: Clock;
  logger: Logger;
  /** Test seam; production uses `crypto.randomUUID`. */
  newId?: () => string;
}

/** Coordinates factual chat replies without allowing the LLM to execute actions directly. */
export class Agent {
  readonly #ds: DataSource;
  readonly #llm: LlmClient;
  readonly #proposals: ProposalStore;
  readonly #messages: MessageStore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #newId: () => string;

  constructor(deps: AgentDeps) {
    this.#ds = deps.ds;
    this.#llm = deps.llm;
    this.#proposals = deps.proposals;
    this.#messages = deps.messages;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#newId = deps.newId ?? randomUUID;
  }

  /**
   * Answers within one overall 30-second budget. Every LLM call receives only the
   * time remaining before the same deadline, and typed LLM errors are preserved.
   */
  async answer(question: string, history: ChatTurn[], deadline: number): Promise<GhostReply> {
    const effectiveDeadline = Math.min(deadline, this.#clock.now() + MAX_ANSWER_MS);
    const snapshot = await readSnapshot(this.#ds, this.#clock);
    const names = snapshot.containers.map(({ name }) => name);
    const mentions = resolveContainerMentions(question, snapshot.containers);
    const intent = detectIntent(question);
    const limit = intent === "summarize" ? 200 : 100;
    const facts = buildFactSheet(snapshot);

    if (intent === "summarize" && mentions.length === 0) {
      return this.#finish(askWhichContainerReply(names));
    }

    let includedLogs: IncludedLogs | undefined;
    if (mentions[0] !== undefined) {
      const result = await this.#readLogsOrUnknown(mentions[0], limit, names);
      if ("reply" in result) return this.#finish(result.reply);
      includedLogs = result.logs;

      if (intent === "summarize" && includedLogs.lines.length === 0) {
        return this.#finish({ text: noLogsTemplate(includedLogs.container) });
      }
    }

    let request = this.#buildRequest(question, history, facts, includedLogs, intent);
    let raw = await this.#complete(request, effectiveDeadline);
    let parsed = this.#parseCompletion(raw);

    const firstReported = this.#reportedContainerReply(parsed, names);
    if (firstReported.reply !== undefined) return this.#finish(firstReported.reply);

    // A model may identify a real container that was not evident in the question.
    // Include its logs and ask again at most once, using the same overall deadline.
    if (
      firstReported.container !== undefined &&
      firstReported.container !== includedLogs?.container &&
      this.#remaining(effectiveDeadline) > 0
    ) {
      const result = await this.#readLogsOrUnknown(firstReported.container, limit, names);
      if ("reply" in result) return this.#finish(result.reply);
      includedLogs = result.logs;
      request = this.#buildRequest(question, history, facts, includedLogs, intent);
      raw = await this.#complete(request, effectiveDeadline);
      parsed = this.#parseCompletion(raw);

      const secondReported = this.#reportedContainerReply(parsed, names);
      if (secondReported.reply !== undefined) return this.#finish(secondReported.reply);
    }

    const allowed = allowedQuantities(facts, [
      question,
      ...(includedLogs?.lines.map((line) => `${line.timestamp} ${line.text}`) ?? []),
    ]);

    let text = parsed.reply;
    const firstGuard = factGuard(text, allowed);
    if (!firstGuard.ok) {
      this.#logger.debug(
        { invalidQuantityCount: firstGuard.invalid.length },
        "LLM reply failed the fact guard",
      );

      if (this.#remaining(effectiveDeadline) > 0) {
        const correction = correctiveRequest(request, raw, firstGuard.invalid);
        raw = await this.#complete(correction, effectiveDeadline);
        parsed = this.#parseCompletion(raw);

        const correctedReported = this.#reportedContainerReply(parsed, names);
        if (correctedReported.reply !== undefined) return this.#finish(correctedReported.reply);

        text = parsed.reply;
        if (!factGuard(text, allowed).ok) {
          text = factTemplateReply(snapshot, mentions);
        }
      } else {
        text = factTemplateReply(snapshot, mentions);
      }
    }

    text = limitWords(text, MAX_REPLY_WORDS);
    const events = intent === "summarize" && includedLogs !== undefined
      ? extractLogEvents(includedLogs.lines)
      : undefined;
    const proposal = this.#registerProposal(parsed.proposal, snapshot);

    return this.#finish({ text, events, proposal }, false);
  }

  /**
   * Writes the persona text for a raised alert with one LLM call and a 10-second timeout.
   * The LLM text is used only when `acceptAlertText` accepts it; any rejection, error, or
   * timeout falls back to the deterministic template (Requirements 5.1, 5.5, 8.3). Never throws.
   */
  async writeAlertMessage(e: AlertEvent): Promise<string> {
    const request: LlmRequest = {
      system: ALERT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `ALERT ${e.ruleId} (${e.severity})\n` +
            `SUBJECT ${subjectLabel(e.subject)}\n` +
            `MEASURED VALUE ${e.measuredValue}`,
        },
      ],
      maxTokens: 120,
      json: false,
    };
    try {
      const raw = await this.#llm.complete(request, ALERT_MESSAGE_TIMEOUT_MS);
      const candidate = raw.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
      if (candidate.length > 0 && acceptAlertText(candidate, e)) return candidate;
      this.#logger.debug({ ruleId: e.ruleId }, "LLM alert text rejected; using template");
    } catch (error) {
      this.#logger.warn({ err: error, ruleId: e.ruleId }, "LLM alert text failed; using template");
    }
    return alertTemplate(e);
  }

  /**
   * Builds and stores the reply for an executed action. The Data_Source error, if any, is kept
   * verbatim, so the reply is not word-limited here (`actionResultReply` keeps it short).
   */
  async reportActionResult(p: ActionProposal, result: ActionResult): Promise<GhostReply> {
    return this.#finish({ text: actionResultReply(p, result) }, false);
  }

  #buildRequest(
    question: string,
    history: ChatTurn[],
    facts: FactSheet,
    logs: IncludedLogs | undefined,
    intent: Intent,
  ): LlmRequest {
    return buildChatPrompt({ question, history, facts, logs, intent });
  }

  async #complete(request: LlmRequest, deadline: number): Promise<string> {
    return this.#llm.complete(request, this.#remaining(deadline));
  }

  #remaining(deadline: number): number {
    return deadline - this.#clock.now();
  }

  #parseCompletion(raw: string): ParsedCompletion {
    try {
      const parsed = CompletionSchema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) return parsed.data;
    } catch {
      // Raw-text fallback is intentional for models that ignore JSON response mode.
    }

    this.#logger.debug("Using raw text from an invalid LLM response envelope");
    return { reply: raw, mentionedContainer: null, proposal: null };
  }

  #reportedContainerReply(
    parsed: ParsedCompletion,
    existing: readonly string[],
  ): { container?: string; reply?: ListedReply } {
    if (parsed.mentionedContainer === null) return {};
    const container = findContainer(parsed.mentionedContainer, existing);
    return container === undefined
      ? { reply: unknownContainerReply(parsed.mentionedContainer, existing) }
      : { container };
  }

  async #readLogsOrUnknown(
    container: string,
    limit: 100 | 200,
    existing: readonly string[],
  ): Promise<{ logs: IncludedLogs } | { reply: ListedReply }> {
    try {
      const lines = await this.#ds.readLogs(container, limit);
      return { logs: { container, lines: lines.slice(-limit), limit } };
    } catch (error) {
      if (error instanceof ContainerNotFoundError) {
        return { reply: unknownContainerReply(error.containerName, existing) };
      }
      throw error;
    }
  }

  #registerProposal(input: unknown, snapshot: Snapshot): ActionProposalDTO | undefined {
    const proposal = validateProposal(input, snapshot);
    if (proposal === null) return undefined;
    return this.#proposals.create({ ...proposal, source: "chat" });
  }

  #finish(
    reply: { text: string; events?: LogEvent[]; list?: string[]; proposal?: ActionProposalDTO },
    applyWordLimit = true,
  ): GhostReply {
    const id = this.#newId();
    const text = applyWordLimit ? limitWords(reply.text, MAX_REPLY_WORDS) : reply.text;
    const result: GhostReply = {
      id,
      text,
      createdAt: new Date(this.#clock.now()).toISOString(),
    };
    if (reply.events !== undefined) result.events = reply.events;
    if (reply.list !== undefined) result.list = reply.list;
    if (reply.proposal !== undefined) result.proposal = reply.proposal;
    this.#messages.put(id, text);
    return result;
  }
}

function correctiveRequest(
  request: LlmRequest,
  rejectedRaw: string,
  invalid: readonly string[],
): LlmRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: rejectedRaw },
      {
        role: "user",
        content:
          `Rewrite the reply using only quantities written in FACTS, QUESTION, or LOGS. ` +
          `These quantities were invalid: ${invalid.join(", ")}. ` +
          "Return the required JSON object with reply, mentionedContainer, and proposal.",
      },
    ],
  };
}

function askWhichContainerReply(existing: readonly string[]): ListedReply {
  if (existing.length === 0) {
    return { text: "Which container should I inspect? No containers are visible in the machine." };
  }

  const inline = `Which container should I inspect? The vessels I can sense are: ${existing.join(", ")}.`;
  if (countWords(inline) <= MAX_REPLY_WORDS) return { text: inline };

  return {
    text: "Which container should I inspect? The vessels I can sense are listed below.",
    list: [...existing],
  };
}
