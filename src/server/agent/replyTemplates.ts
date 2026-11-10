/**
 * Deterministic ghost-persona replies used when the Agent must not rely on LLM prose.
 * Spoken template text is kept to at most 120 whitespace-separated words.
 */

import type { Snapshot } from "../../shared/types.js";
import { countWords } from "../../shared/words.js";
import type { ActionProposal, ActionResult } from "../actions/types.js";
import { allowedQuantities, factGuard } from "./factGuard.js";
import { buildFactSheet } from "./factSheet.js";

const MAX_REPLY_WORDS = 120;

export interface ListedReply {
  text: string;
  /** Content rendered by the Chat_Page but omitted from speech. */
  list?: string[];
}

/**
 * Reports an unknown container and shows the real container names. When speaking every
 * name would cross the word limit, the names move to the non-spoken list.
 */
export function unknownContainerReply(
  name: string,
  existing: readonly string[],
): ListedReply {
  if (existing.length === 0) {
    return {
      text: `The wires whisper of no container named ${name}. No containers are visible in this machine.`,
    };
  }

  const inline = `The wires whisper of no container named ${name}. The vessels I can sense are: ${existing.join(", ")}.`;
  if (countWords(inline) <= MAX_REPLY_WORDS) return { text: inline };

  return {
    text: `The wires whisper of no container named ${name}. The real containers are shown below, beyond the ghost's spoken breath.`,
    list: [...existing],
  };
}

/** Reply used when a known container has no log lines to summarize. */
export function noLogsTemplate(name: string): string {
  return `The vessel ${name} is silent. No log lines haunt its record.`;
}

/** Generic client-safe reply for a failed or timed-out chat request. */
export function chatFailureMessage(): string {
  return "The signal faded into the static before I could answer. Try calling into the machine again.";
}

/** Reports an executed action's success or its Data_Source error verbatim. */
export function actionResultReply(p: ActionProposal, result: ActionResult): string {
  if (result.ok) {
    return `The ${p.action} ritual for ${p.container} succeeded. The machine answers once more.`;
  }

  const reply = `The ${p.action} ritual for ${p.container} failed. The machine answered: ${result.error}`;
  if (countWords(reply) <= MAX_REPLY_WORDS) return reply;

  // Keep the required action, container, and complete verbatim error while removing
  // avoidable prose. Data_Source error messages are expected to fit the reply budget.
  return `${p.action}:${p.container}:${result.error}`;
}

/**
 * Factual fallback used after generated prose fails the fact guard. It reports host facts
 * and as many exactly-mentioned containers as fit without crossing the spoken word limit.
 */
export function factTemplateReply(s: Snapshot, mentions: readonly string[]): string {
  const facts = buildFactSheet(s);
  let reply =
    `The machine speaks plainly: host CPU is ${facts.host.cpu}; host memory is ${facts.host.memory}, ` +
    `${facts.host.memoryUsed} of ${facts.host.memoryTotal}.`;

  const mentioned = new Set(mentions);
  for (const container of facts.containers) {
    if (!mentioned.has(container.name)) continue;
    const detail =
      ` ${container.name} is ${container.state}, with CPU ${container.cpu} and memory ${container.memory}.`;
    if (countWords(reply + detail) <= MAX_REPLY_WORDS) reply += detail;
  }

  const allowed = allowedQuantities(facts, []);
  if (!factGuard(reply, allowed).ok) {
    throw new Error("Fact template produced a quantity absent from its fact sheet");
  }
  return reply;
}
