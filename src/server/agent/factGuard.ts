/**
 * Fact guard: checks that every quantity in an LLM reply appears exactly in the
 * source data (Requirements 6.4, 8.4).
 *
 * A quantity is a number followed by a percent sign or a byte unit (KB, KiB, MB, MiB,
 * GB, GiB, TB, TiB, bytes), with optional whitespace in between. Bare "B" is not
 * counted, matching the design. Quantities are compared after normalization:
 * whitespace removed and the unit lower-cased, so "512.0 MiB", "512.0MiB" and
 * "512.0 mib" are the same quantity, while "12.3%" and "12.30%" are not.
 */

import { factLines, type FactSheet } from "./factSheet.js";

const QUANTITY_RE = /(\d+(?:\.\d+)?)\s*(%|[KMGT]i?B\b|bytes\b)/gi;

/** Returns the normalized quantities in `text`, in order of appearance (duplicates kept). */
export function extractQuantities(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUANTITY_RE)) {
    const [, number, unit] = m;
    if (number !== undefined && unit !== undefined) out.push(number + unit.toLowerCase());
  }
  return out;
}

/**
 * Quantities the reply may use: those in the fact sheet plus those in `extraTexts`
 * (the user question and the log lines included in the prompt).
 */
export function allowedQuantities(f: FactSheet, extraTexts: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of [...factLines(f), ...extraTexts]) {
    for (const q of extractQuantities(text)) allowed.add(q);
  }
  return allowed;
}

/** `ok` exactly when every quantity in `reply` is allowed; `invalid` lists the others once each, in order. */
export function factGuard(
  reply: string,
  allowed: ReadonlySet<string>,
): { ok: true } | { ok: false; invalid: string[] } {
  const invalid = [...new Set(extractQuantities(reply).filter((q) => !allowed.has(q)))];
  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}
