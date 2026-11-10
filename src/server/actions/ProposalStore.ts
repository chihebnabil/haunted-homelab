/**
 * Action_Proposal lifecycle (Requirement 11).
 *
 * The pure functions below hold every state transition. The `ProposalStore` class wraps them,
 * reads the injected clock, and is the only holder of an `ActionExecutor` (design decision 5,
 * Requirement 11.5). The executor runs only from `ProposalStore.confirm` on a pending proposal.
 */

import { randomUUID } from "node:crypto";
import type {
  ActionKind,
  ActionProposalDTO,
  Clock,
  ConfirmRejectionReason,
} from "../../shared/types.js";
import type { DataSource } from "../datasource/types.js";
import { ActionExecutor } from "./ActionExecutor.js";
import type { ActionProposal, ActionResult, ProposalSource } from "./types.js";

/** Proposals stay confirmable for 5 minutes after creation. The boundary is inclusive (11.8). */
export const PROPOSAL_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Pure state
// ---------------------------------------------------------------------------

export interface ProposalState {
  /** Insertion order is creation order. Never mutated; every transition returns a new map. */
  readonly proposals: ReadonlyMap<string, ActionProposal>;
}

export type ConfirmDecision =
  | { kind: "execute"; proposal: ActionProposal }
  | { kind: "rejected"; reason: ConfirmRejectionReason; proposal?: ActionProposal };

export type CancelDecision =
  | { ok: true; proposal: ActionProposal }
  | { ok: false; reason: Exclude<ConfirmRejectionReason, "expired">; proposal?: ActionProposal };

export function initialProposalState(): ProposalState {
  return { proposals: new Map() };
}

/** Adds a pending proposal. Throws if the id is already used. */
export function createProposal(s: ProposalState, p: Omit<ActionProposal, "status">): ProposalState {
  if (s.proposals.has(p.id)) throw new Error(`Duplicate proposal id: ${p.id}`);
  return withProposal(s, { ...p, status: "pending" });
}

/**
 * Decides a confirm at time `now`. A pending proposal within the TTL becomes `confirmed` in the
 * returned state, before any action runs, so a later confirm is rejected (11.9). A pending proposal
 * past the TTL becomes `expired` and is rejected (11.8).
 */
export function confirm(
  s: ProposalState,
  id: string,
  now: number,
): { state: ProposalState; decision: ConfirmDecision } {
  const p = s.proposals.get(id);
  if (p === undefined) return { state: s, decision: { kind: "rejected", reason: "not_found" } };

  if (p.status !== "pending") {
    return { state: s, decision: { kind: "rejected", reason: terminalReason(p.status), proposal: p } };
  }

  if (now - p.createdAt > PROPOSAL_TTL_MS) {
    const expired: ActionProposal = { ...p, status: "expired" };
    return {
      state: withProposal(s, expired),
      decision: { kind: "rejected", reason: "expired", proposal: expired },
    };
  }

  const confirmed: ActionProposal = { ...p, status: "confirmed" };
  return { state: withProposal(s, confirmed), decision: { kind: "execute", proposal: confirmed } };
}

/** Moves a pending proposal to `cancelled` (11.6). Any other status is rejected. */
export function cancel(s: ProposalState, id: string): { state: ProposalState; decision: CancelDecision } {
  const p = s.proposals.get(id);
  if (p === undefined) return { state: s, decision: { ok: false, reason: "not_found" } };

  if (p.status !== "pending") {
    return { state: s, decision: { ok: false, reason: terminalReason(p.status), proposal: p } };
  }

  const cancelled: ActionProposal = { ...p, status: "cancelled" };
  return { state: withProposal(s, cancelled), decision: { ok: true, proposal: cancelled } };
}

/** Browser-facing view: ISO times and `expiresAt = createdAt + TTL`. Drops the server-only `source`. */
export function toProposalDTO(p: ActionProposal): ActionProposalDTO {
  return {
    id: p.id,
    action: p.action,
    container: p.container,
    reason: p.reason,
    createdAt: new Date(p.createdAt).toISOString(),
    expiresAt: new Date(p.createdAt + PROPOSAL_TTL_MS).toISOString(),
    status: p.status,
  };
}

function withProposal(s: ProposalState, p: ActionProposal): ProposalState {
  const next = new Map(s.proposals);
  next.set(p.id, p);
  return { proposals: next };
}

function terminalReason(
  status: Exclude<ActionProposal["status"], "pending">,
): Exclude<ConfirmRejectionReason, "expired" | "not_found"> {
  switch (status) {
    case "confirmed":
      return "already_confirmed";
    case "cancelled":
      return "already_cancelled";
    case "expired":
      return "already_expired";
  }
}

// ---------------------------------------------------------------------------
// Stateful wrapper
// ---------------------------------------------------------------------------

export interface NewProposal {
  action: ActionKind;
  container: string;
  reason: string;
  source: ProposalSource;
}

export type ConfirmOutcome =
  | { kind: "executed"; proposal: ActionProposal; dto: ActionProposalDTO; result: ActionResult }
  | { kind: "rejected"; reason: ConfirmRejectionReason; proposal?: ActionProposal; dto?: ActionProposalDTO };

export type CancelOutcome =
  | { ok: true; dto: ActionProposalDTO }
  | { ok: false; reason: Exclude<ConfirmRejectionReason, "expired">; dto?: ActionProposalDTO };

export interface ProposalStoreDeps {
  ds: DataSource;
  clock: Clock;
  /** Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

export class ProposalStore {
  #state: ProposalState = initialProposalState();
  /** The only ActionExecutor in the Backend (11.5). Never exposed. */
  readonly #executor: ActionExecutor;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: ProposalStoreDeps) {
    this.#executor = new ActionExecutor(deps.ds);
    this.#clock = deps.clock;
    this.#newId = deps.newId ?? randomUUID;
  }

  create(input: NewProposal): ActionProposalDTO {
    const id = this.#newId();
    this.#state = createProposal(this.#state, {
      id,
      action: input.action,
      container: input.container,
      reason: input.reason,
      source: input.source,
      createdAt: this.#clock.now(),
    });
    return this.#dto(id);
  }

  /**
   * Commits the decision synchronously, then runs the action. A second confirm that arrives while
   * the first action is still running sees `confirmed` and is rejected (11.9).
   */
  async confirm(id: string): Promise<ConfirmOutcome> {
    const { state, decision } = confirm(this.#state, id, this.#clock.now());
    this.#state = state;

    if (decision.kind === "rejected") {
      return decision.proposal === undefined
        ? { kind: "rejected", reason: decision.reason }
        : {
            kind: "rejected",
            reason: decision.reason,
            proposal: decision.proposal,
            dto: toProposalDTO(decision.proposal),
          };
    }

    const result = await this.#executor.run(decision.proposal);
    return { kind: "executed", proposal: decision.proposal, dto: toProposalDTO(decision.proposal), result };
  }

  cancel(id: string): CancelOutcome {
    const { state, decision } = cancel(this.#state, id);
    this.#state = state;
    if (decision.ok) return { ok: true, dto: toProposalDTO(decision.proposal) };
    return decision.proposal === undefined
      ? { ok: false, reason: decision.reason }
      : { ok: false, reason: decision.reason, dto: toProposalDTO(decision.proposal) };
  }

  get(id: string): ActionProposalDTO | undefined {
    const p = this.#state.proposals.get(id);
    return p === undefined ? undefined : toProposalDTO(p);
  }

  /** All proposals in creation order. */
  list(): ActionProposalDTO[] {
    return [...this.#state.proposals.values()].map(toProposalDTO);
  }

  #dto(id: string): ActionProposalDTO {
    const p = this.#state.proposals.get(id);
    if (p === undefined) throw new Error(`Proposal missing after create: ${id}`);
    return toProposalDTO(p);
  }
}
