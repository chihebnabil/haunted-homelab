/**
 * Error and warning event extraction from Container_Log lines (Requirement 7.2).
 *
 * Keywords match as whole words, case-insensitively. A keyword boundary is any character
 * that is not a letter or digit, so "ERROR:", "[warn]", and "error_code" match while
 * "terrorist" and "forewarned" do not. When a line has both error and warning keywords,
 * it is classified as an error.
 */

import type { LogEvent, LogLine } from "../../shared/types.js";

const ERROR_KEYWORDS =
  /(?<![\p{L}\p{N}])(?:errors?|err|fatal|panic|panicked|exceptions?|crit|critical|failed|failure)(?![\p{L}\p{N}])/iu;
const WARNING_KEYWORDS = /(?<![\p{L}\p{N}])(?:warn|warning|warnings)(?![\p{L}\p{N}])/iu;

export type LogLevel = LogEvent["level"];

/** `error`, `warning`, or `null` for a line without either kind of keyword. */
export function classifyLine(text: string): LogLevel | null {
  if (ERROR_KEYWORDS.test(text)) return "error";
  if (WARNING_KEYWORDS.test(text)) return "warning";
  return null;
}

/** The error and warning lines of `lines`, in log order, with their original timestamp and text. */
export function extractLogEvents(lines: readonly LogLine[]): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of lines) {
    const level = classifyLine(line.text);
    if (level !== null) events.push({ timestamp: line.timestamp, level, text: line.text });
  }
  return events;
}
