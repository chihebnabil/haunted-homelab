import type { AlertSeverity, AlertSubject, HauntingAlert } from "./types.js";

/**
 * Stable key for an alert subject, used by the Status_Panel to look up severity marks
 * and by the rule engine to build alert keys (`${ruleId}:${subjectKey(subject)}`).
 * Examples: "host:cpu", "filesystem:/mnt/media", "container:plex", "data_source".
 */
export function subjectKey(subject: AlertSubject): string {
  switch (subject.kind) {
    case "host":
      return `host:${subject.resource}`;
    case "filesystem":
      return `filesystem:${subject.mount}`;
    case "container":
      return `container:${subject.name}`;
    case "data_source":
      return "data_source";
  }
}

const RANK: Record<AlertSeverity, number> = { warning: 1, critical: 2 };

/**
 * Maps each subject key to the highest severity among its unresolved alerts
 * (critical over warning). Subjects without unresolved alerts are absent (Requirement 10.4).
 */
export function computeSeverityMarks(alerts: readonly HauntingAlert[]): Map<string, AlertSeverity> {
  const marks = new Map<string, AlertSeverity>();
  for (const alert of alerts) {
    if (alert.status !== "active") continue;
    const key = subjectKey(alert.subject);
    const current = marks.get(key);
    if (current === undefined || RANK[alert.severity] > RANK[current]) {
      marks.set(key, alert.severity);
    }
  }
  return marks;
}
