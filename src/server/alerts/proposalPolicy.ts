import type { AlertEvent } from "../../shared/types.js";
import type { NewProposal } from "../actions/ProposalStore.js";

/**
 * Maps actionable container alerts to safe proposals. Alert rules whose subjects do not identify a
 * container cannot produce a proposal.
 */
export function proposalPolicy(event: AlertEvent): NewProposal | null {
  if (event.subject.kind !== "container") return null;

  switch (event.ruleId) {
    case "container_exited":
      return {
        action: "restart",
        container: event.subject.name,
        reason: `Restore exited container ${event.subject.name}.`,
        source: "alert",
      };
    case "container_restarting":
      return {
        action: "restart",
        container: event.subject.name,
        reason: `Recover restarting container ${event.subject.name}.`,
        source: "alert",
      };
    case "new_container_cpu":
      return {
        action: "stop",
        container: event.subject.name,
        reason: `Stop newly detected high-CPU container ${event.subject.name}.`,
        source: "alert",
      };
    default:
      return null;
  }
}
