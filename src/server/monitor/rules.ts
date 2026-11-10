/**
 * Pure alert rule engine (Requirements 4.2-4.10).
 *
 * `evaluateRules` takes the previous rule state and one monitor input (a successful
 * Snapshot or a failed read) and returns the next state plus the alerts raised and
 * resolved at this step. It never mutates its arguments. The Monitor only schedules
 * polls and forwards the events.
 */

import { formatPercent, usagePercent } from "../../shared/format.js";
import { subjectKey } from "../../shared/severity.js";
import type {
  AlertEvent,
  AlertRuleId,
  AlertSeverity,
  AlertSubject,
  Snapshot,
  Thresholds,
} from "../../shared/types.js";

// Re-exported so alert keys built here match the Status_Panel severity lookups.
export { subjectKey };

export interface RuleState {
  /** Latest successful snapshot. Failed reads do not replace it. */
  previous?: Snapshot;
  /** readAt (epoch ms) of the first snapshot in the current run of host CPU above the threshold. */
  cpuAboveSince?: number;
  /** Containers that went running -> exited and are still exited. */
  exitedLatch: ReadonlySet<string>;
  /** Containers that appeared hot after a previous snapshot existed and are still hot. */
  newHotLatch: ReadonlySet<string>;
  /** Active alerts by key, holding the event as it was raised. */
  active: ReadonlyMap<string, AlertEvent>;
}

export type MonitorInput =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; at: string; error: string };

export interface RuleResult {
  state: RuleState;
  raised: AlertEvent[];
  /** The active events whose condition stopped being true, as originally raised. */
  resolved: AlertEvent[];
}

export function initialRuleState(): RuleState {
  return { exitedLatch: new Set(), newHotLatch: new Set(), active: new Map() };
}

/** `${ruleId}:${subjectKey(subject)}`, e.g. "disk:filesystem:/" or "container_exited:container:plex". */
export function alertKey(ruleId: AlertRuleId, subject: AlertSubject): string {
  return `${ruleId}:${subjectKey(subject)}`;
}

const DATA_SOURCE_SUBJECT: AlertSubject = { kind: "data_source" };
const DATA_SOURCE_KEY = alertKey("data_source_unavailable", DATA_SOURCE_SUBJECT);

function makeEvent(
  ruleId: AlertRuleId,
  subject: AlertSubject,
  severity: AlertSeverity,
  measuredValue: string,
  detectedAt: string,
): AlertEvent {
  return { key: alertKey(ruleId, subject), ruleId, subject, severity, measuredValue, detectedAt };
}

export function evaluateRules(state: RuleState, input: MonitorInput, t: Thresholds): RuleResult {
  if (!input.ok) return evaluateError(state, input);

  const s = input.snapshot;
  const readAtMs = Date.parse(s.readAt);
  const detectedAt = s.readAt;
  const hadPrevious = state.previous !== undefined;
  const prevStates = new Map<string, string>();
  for (const c of state.previous?.containers ?? []) {
    if (!prevStates.has(c.name)) prevStates.set(c.name, c.state);
  }

  // Conditions that are true for this snapshot, keyed by alert key, in a stable order.
  const current = new Map<string, AlertEvent>();
  const add = (e: AlertEvent): void => {
    if (!current.has(e.key)) current.set(e.key, e);
  };

  // host_cpu: sustained above the threshold for at least the CPU duration (4.2).
  let cpuAboveSince: number | undefined;
  if (s.host.cpuPercent > t.cpuPercent) {
    cpuAboveSince = state.cpuAboveSince ?? readAtMs;
    if (readAtMs - cpuAboveSince >= t.cpuDurationSeconds * 1000) {
      add(
        makeEvent(
          "host_cpu",
          { kind: "host", resource: "cpu" },
          "warning",
          formatPercent(s.host.cpuPercent),
          detectedAt,
        ),
      );
    }
  }

  // host_memory (4.3).
  const memPercent = usagePercent(s.host.memoryUsedBytes, s.host.memoryTotalBytes);
  if (memPercent > t.memoryPercent) {
    add(
      makeEvent(
        "host_memory",
        { kind: "host", resource: "memory" },
        "warning",
        formatPercent(memPercent),
        detectedAt,
      ),
    );
  }

  // disk per mount (4.4).
  for (const fs of s.host.filesystems) {
    const pct = usagePercent(fs.usedBytes, fs.totalBytes);
    if (pct > t.diskPercent) {
      add(makeEvent("disk", { kind: "filesystem", mount: fs.mount }, "warning", formatPercent(pct), detectedAt));
    }
  }

  // Container rules (4.5-4.7). Latches are rebuilt from the current snapshot, so a
  // container that disappears or leaves the condition drops out of its latch.
  const exitedLatch = new Set<string>();
  const newHotLatch = new Set<string>();
  const seen = new Set<string>();
  for (const c of s.containers) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const subject: AlertSubject = { kind: "container", name: c.name };

    if (c.state === "exited" && (state.exitedLatch.has(c.name) || prevStates.get(c.name) === "running")) {
      exitedLatch.add(c.name);
      add(makeEvent("container_exited", subject, "critical", "exited", detectedAt));
    }

    if (c.state === "restarting") {
      add(makeEvent("container_restarting", subject, "critical", "restarting", detectedAt));
    }

    const isNew = hadPrevious && !prevStates.has(c.name);
    if (c.cpuPercent > t.cpuPercent && (state.newHotLatch.has(c.name) || isNew)) {
      newHotLatch.add(c.name);
      add(makeEvent("new_container_cpu", subject, "warning", formatPercent(c.cpuPercent), detectedAt));
    }
  }

  // data_source_unavailable is false on any successful snapshot (4.10).
  const { active, raised, resolved } = diff(state.active, current);

  const next: RuleState = { previous: s, exitedLatch, newHotLatch, active };
  if (cpuAboveSince !== undefined) next.cpuAboveSince = cpuAboveSince;
  return { state: next, raised, resolved };
}

/** A failed read only makes data_source_unavailable true; everything else is kept as is. */
function evaluateError(state: RuleState, input: { at: string; error: string }): RuleResult {
  if (state.active.has(DATA_SOURCE_KEY)) return { state, raised: [], resolved: [] };
  const event = makeEvent(
    "data_source_unavailable",
    DATA_SOURCE_SUBJECT,
    "critical",
    input.error.trim() || "unavailable",
    input.at,
  );
  const active = new Map(state.active);
  active.set(DATA_SOURCE_KEY, event);
  return { state: { ...state, active }, raised: [event], resolved: [] };
}

/** raised = true keys not active (4.8); resolved = active keys no longer true (4.9). */
function diff(
  previous: ReadonlyMap<string, AlertEvent>,
  current: ReadonlyMap<string, AlertEvent>,
): { active: Map<string, AlertEvent>; raised: AlertEvent[]; resolved: AlertEvent[] } {
  const active = new Map<string, AlertEvent>();
  const raised: AlertEvent[] = [];
  const resolved: AlertEvent[] = [];
  for (const [key, event] of previous) {
    if (!current.has(key)) resolved.push(event);
  }
  for (const [key, event] of current) {
    const existing = previous.get(key);
    if (existing) {
      active.set(key, existing);
    } else {
      active.set(key, event);
      raised.push(event);
    }
  }
  return { active, raised, resolved };
}
