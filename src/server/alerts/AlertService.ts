/**
 * Turns rule engine events into Haunting_Alerts (Requirements 4.9, 5.1, 5.2, 5.6, 11.1, 11.2).
 *
 * Events for the same alert key run in order on a per-key promise chain, so a `resolved`
 * event never overtakes the `raised` event it belongs to, even while the Agent is still
 * writing the alert message.
 */

import { randomUUID } from "node:crypto";
import type { ActionProposalDTO, AlertEvent, Clock, HauntingAlert } from "../../shared/types.js";
import type { ProposalStore } from "../actions/ProposalStore.js";
import type { Agent } from "../agent/Agent.js";
import type { WsHub } from "../http/hub.js";
import type { Logger } from "../logging/logger.js";
import type { MessageStore } from "../messages/MessageStore.js";
import { proposalPolicy } from "./proposalPolicy.js";
import { recoveryTemplate } from "./templates.js";

/** Resolved alerts kept for `GET /api/state`, oldest dropped first. */
export const MAX_RESOLVED_ALERTS = 100;

export interface AlertServiceDeps {
  agent: Pick<Agent, "writeAlertMessage">;
  proposals: Pick<ProposalStore, "create">;
  hub: WsHub;
  messages: MessageStore;
  clock: Clock;
  logger: Logger;
  /** Test seam; production uses `crypto.randomUUID`. */
  newId?: () => string;
}

export class AlertService {
  readonly #deps: AlertServiceDeps;
  readonly #newId: () => string;
  /** Active alerts by alert key. */
  readonly #active = new Map<string, HauntingAlert>();
  readonly #resolved: HauntingAlert[] = [];
  /** Tail of each key's promise chain. */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(deps: AlertServiceDeps) {
    this.#deps = deps;
    this.#newId = deps.newId ?? randomUUID;
  }

  /** Queues every event on its key's chain. Returns immediately; work continues in the background. */
  handle(raised: readonly AlertEvent[], resolved: readonly AlertEvent[]): void {
    for (const e of raised) this.#enqueue(e.key, () => this.#raise(e));
    for (const e of resolved) this.#enqueue(e.key, () => this.#resolve(e));
  }

  /** Active alerts, oldest first. */
  activeAlerts(): HauntingAlert[] {
    return [...this.#active.values()];
  }

  /** Active alerts followed by the most recent resolved alerts, for `GET /api/state`. */
  recentAlerts(): HauntingAlert[] {
    return [...this.#resolved, ...this.#active.values()];
  }

  /** Resolves once every queued event has been processed. Used by tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#chains.size > 0) await Promise.all([...this.#chains.values()]);
  }

  #enqueue(key: string, work: () => Promise<void>): void {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch((err: unknown) => {
      this.#deps.logger.error({ err, key }, "alert event processing failed");
    });
    this.#chains.set(key, next);
    void next.then(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
  }

  async #raise(e: AlertEvent): Promise<void> {
    if (this.#active.has(e.key)) return;
    const { agent, proposals, hub, messages } = this.#deps;

    const message = await agent.writeAlertMessage(e);
    const id = this.#newId();
    messages.put(id, message);

    const policy = proposalPolicy(e);
    let proposal: ActionProposalDTO | undefined;
    if (policy !== null) {
      try {
        proposal = proposals.create(policy);
      } catch (err) {
        this.#deps.logger.error({ err, key: e.key }, "could not create alert proposal");
      }
    }

    const alert: HauntingAlert = { ...e, id, message, status: "active" };
    if (proposal !== undefined) alert.proposalId = proposal.id;
    this.#active.set(e.key, alert);

    hub.broadcast(proposal === undefined ? { type: "alert.raised", alert } : { type: "alert.raised", alert, proposal });
  }

  async #resolve(e: AlertEvent): Promise<void> {
    const alert = this.#active.get(e.key);
    if (alert === undefined) return;
    const { hub, messages, clock } = this.#deps;

    const recoveryMessage = recoveryTemplate(e);
    const recoveryMessageId = this.#newId();
    messages.put(recoveryMessageId, recoveryMessage);
    const resolvedAt = new Date(clock.now()).toISOString();

    this.#active.delete(e.key);
    this.#resolved.push({ ...alert, status: "resolved", resolvedAt, recoveryMessage, recoveryMessageId });
    if (this.#resolved.length > MAX_RESOLVED_ALERTS) this.#resolved.shift();

    hub.broadcast({ type: "alert.resolved", alertId: alert.id, resolvedAt, recoveryMessage, recoveryMessageId });
  }
}
