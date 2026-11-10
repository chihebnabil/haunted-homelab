import { useState } from "react";
import { useStore } from "zustand";
import type { ActionProposalDTO, ConfirmRejectionReason, GhostReply, ProposalStatus } from "../../shared/types.js";
import { api as defaultApi, ApiError, type ApiClient } from "../api/rest.js";
import { hauntedStore, selectProposal, type HauntedStore } from "../state/store.js";
import "./ProposalCard.css";

export interface ProposalCardProps {
  proposal: ActionProposalDTO;
  store?: HauntedStore;
  api?: ApiClient;
  /** Called with the action result reply returned by a successful confirm. */
  onReply?: (reply: GhostReply) => void;
}

const STATUS_LABEL: Record<Exclude<ProposalStatus, "pending">, string> = {
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  expired: "Expired",
};

const REJECTION_TEXT: Record<ConfirmRejectionReason, string> = {
  expired: "This offering has expired. The moment has passed.",
  already_confirmed: "This offering was already accepted.",
  already_cancelled: "This offering was already refused.",
  already_expired: "This offering has expired. The moment has passed.",
  not_found: "This offering has vanished from the spirit realm.",
};

const FAILURE_TEXT = "The spirits could not carry your answer. Try again.";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/** An Action_Proposal with Confirm and Cancel controls (Requirements 11.2, 11.6, 11.8). */
export function ProposalCard({ proposal, store = hauntedStore, api = defaultApi, onReply }: ProposalCardProps) {
  const latest = useStore(store, (s) => selectProposal(s, proposal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const pending = latest.status === "pending";
  const disabled = !pending || busy;

  function applyProposal(p: ActionProposalDTO) {
    store.getState().applyEvent({ type: "proposal.updated", proposal: p });
  }

  function handleFailure(err: unknown) {
    if (err instanceof ApiError) {
      if (err.proposal) applyProposal(err.proposal);
      const reason = err.reason;
      setError(reason ? REJECTION_TEXT[reason] : (err.errorText ?? FAILURE_TEXT));
    } else {
      setError(FAILURE_TEXT);
    }
  }

  async function onConfirm() {
    if (disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.confirmProposal(latest.id);
      applyProposal(res.proposal);
      // Appends without touching the chat waiting flag; deduped against the broadcast chat.message.
      store.getState().applyEvent({ type: "chat.message", reply: res.reply });
      onReply?.(res.reply);
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.cancelProposal(latest.id);
      applyProposal(res.proposal);
    } catch (err) {
      handleFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`proposal-card proposal-card--${latest.status}`}
      aria-label={`Proposal to ${latest.action} ${latest.container}`}
      data-status={latest.status}
    >
      <header className="proposal-card__head">
        <span className="proposal-card__kicker">Proposed action</span>
        {latest.status === "pending" ? (
          <span className="proposal-card__expiry">
            Expires <time dateTime={latest.expiresAt}>{formatTime(latest.expiresAt)}</time>
          </span>
        ) : (
          <p className="proposal-card__status" role="status">
            {STATUS_LABEL[latest.status]}
          </p>
        )}
      </header>
      <p className="proposal-card__title">
        <span className="proposal-card__action">{latest.action}</span>{" "}
        <span className="proposal-card__container">{latest.container}</span>
      </p>
      <p className="proposal-card__reason">{latest.reason}</p>
      <div className="proposal-card__controls">
        <button type="button" className="btn btn--primary btn--sm" onClick={onConfirm} disabled={disabled}>
          Confirm
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="proposal-card__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
