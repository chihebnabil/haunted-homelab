import type { AlertEvent, AlertSubject } from "../../shared/types.js";
import { countWords } from "../../shared/words.js";

const ALERT_WORD_LIMIT = 40;

/** Returns the human-readable resource name used verbatim in alert text. */
export function subjectLabel(subject: AlertSubject): string {
  switch (subject.kind) {
    case "host":
      return subject.resource === "cpu" ? "host CPU" : "host memory";
    case "filesystem":
      return `filesystem ${subject.mount}`;
    case "container":
      return subject.name;
    case "data_source":
      return "data source";
  }
}

/**
 * Builds deterministic Ghost_Persona fallback text containing the source subject and
 * measured value verbatim. If decorative wording would exceed the alert limit, the
 * shortest useful form is used without truncating either fact.
 */
export function alertTemplate(event: AlertEvent): string {
  const label = subjectLabel(event.subject);
  let message: string;

  switch (event.ruleId) {
    case "host_cpu":
      message = `A strange process is haunting the CPU. The ${label} burns at ${event.measuredValue} and will not rest.`;
      break;
    case "host_memory":
      message = `A hungry spirit grips ${label}. Its burden has risen to ${event.measuredValue}.`;
      break;
    case "disk":
      message = `A shadow crowds ${label}. Its usage has risen to ${event.measuredValue}.`;
      break;
    case "container_exited":
      message = `The spirit of ${label} has left its vessel. It now lies ${event.measuredValue} in the dark.`;
      break;
    case "container_restarting":
      message = `The spirit of ${label} is trapped in a loop. It remains ${event.measuredValue} in the dark.`;
      break;
    case "new_container_cpu":
      message = `An unfamiliar spirit haunts ${label}. Its CPU burns at ${event.measuredValue}.`;
      break;
    case "data_source_unavailable":
      message = `The ${label} has vanished into static. It whispers ${event.measuredValue}.`;
      break;
  }

  return countWords(message) <= ALERT_WORD_LIMIT
    ? message
    : `${label}: ${event.measuredValue}`;
}

/** Builds the deterministic Ghost_Persona message shown when an alert resolves. */
export function recoveryTemplate(event: AlertEvent): string {
  return `The haunting of ${subjectLabel(event.subject)} has lifted. The machine breathes easy again.`;
}

/** Accepts LLM alert text only when it retains both facts and respects the word cap. */
export function acceptAlertText(candidate: string, event: AlertEvent): boolean {
  return (
    countWords(candidate) <= ALERT_WORD_LIMIT &&
    candidate.includes(subjectLabel(event.subject)) &&
    candidate.includes(event.measuredValue)
  );
}
