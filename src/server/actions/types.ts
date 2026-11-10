/**
 * Server-side Action_Proposal and action result types (Requirement 11).
 *
 * The browser sees proposals only as `ActionProposalDTO` (shared/types.ts), which carries
 * ISO times and `expiresAt`. The server keeps `createdAt` as epoch ms for clock arithmetic.
 */

import type { ActionKind, ProposalStatus } from "../../shared/types.js";

/** Where a proposal came from: a chat reply or an alert's proposal policy. */
export type ProposalSource = "chat" | "alert";

export interface ActionProposal {
  id: string;
  action: ActionKind;
  container: string;
  reason: string;
  /** Epoch ms from the injected clock. */
  createdAt: number;
  status: ProposalStatus;
  source: ProposalSource;
}

/** Outcome of running an Action through the Data_Source. `error` is the Data_Source message (Requirement 11.7). */
export type ActionResult = { ok: true } | { ok: false; error: string };
