import { useStore } from "zustand";
import type { ActionProposalDTO } from "../../shared/types.js";
import { api as defaultApi, type ApiClient } from "../api/rest.js";
import { hauntedStore, type HauntedStore, type Popup, type VoiceStatus } from "../state/store.js";
import { ProposalCard } from "./ProposalCard.js";
import "./AlertPopupStack.css";

export interface AlertPopupStackProps {
  /** Store to read from. Defaults to the application store. */
  store?: HauntedStore;
  /** REST client for the Confirm and Cancel controls of alert proposals. */
  api?: ApiClient;
}

/** Popups beyond this count stay in the store but are hidden until newer ones are dismissed. */
export const MAX_VISIBLE_POPUPS = 3;

/** Formats an ISO time as local time of day. Falls back to the raw string when it does not parse. */
export function formatPopupTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function popupTitle(popup: Popup): string {
  if (popup.kind === "recovery") return "Recovered";
  return popup.severity === "critical" ? "Critical haunting" : "Warning";
}

interface PopupItemProps {
  popup: Popup;
  voice: VoiceStatus | undefined;
  proposal: ActionProposalDTO | undefined;
  store: HauntedStore;
  api: ApiClient;
  onDismiss: (id: string) => void;
}

function PopupItem(props: PopupItemProps) {
  const { popup, voice, proposal, store, api, onDismiss } = props;
  const tone = popup.kind === "recovery" ? "recovery" : popup.severity;
  const title = popupTitle(popup);
  const timeLabel = popup.kind === "recovery" ? "Resolved" : "Detected";

  return (
    <li
      className={`alert-popup alert-popup--${tone}`}
      role={tone === "critical" ? "alert" : "status"}
      aria-label={title}
      data-popup-kind={popup.kind}
      data-severity={popup.kind === "alert" ? popup.severity : undefined}
    >
      <div className="alert-popup__header">
        <span className="alert-popup__severity">{title}</span>
        <button
          type="button"
          className="alert-popup__dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => onDismiss(popup.id)}
        >
          ×
        </button>
      </div>
      <p className="alert-popup__message">{popup.message}</p>
      {proposal && <ProposalCard proposal={proposal} store={store} api={api} />}
      <div className="alert-popup__footer">
        <span className="alert-popup__time">
          {timeLabel} <time dateTime={popup.at}>{formatPopupTime(popup.at)}</time>
        </span>
        {voice === "failed" && (
          <span className="alert-popup__voice-failed" role="img" aria-label="Voice failed" title="The voice was lost in the static">
            🔇
          </span>
        )}
      </div>
    </li>
  );
}

/** Alert and recovery popups, oldest first (Requirements 5.2, 5.4, 5.6). */
export function AlertPopupStack({ store = hauntedStore, api = defaultApi }: AlertPopupStackProps) {
  const popups = useStore(store, (s) => s.popups);
  const voiceStatus = useStore(store, (s) => s.voiceStatus);
  const alerts = useStore(store, (s) => s.alerts);
  const proposals = useStore(store, (s) => s.chat.proposals);
  const dismissPopup = useStore(store, (s) => s.dismissPopup);

  if (popups.length === 0) return null;

  // Only the newest popups are shown, so the stack never buries the page.
  const visible = popups.slice(-MAX_VISIBLE_POPUPS);
  const hidden = popups.length - visible.length;

  // Alert popups show the proposal attached to their alert, so it can be confirmed (Requirement 11.2).
  const proposalFor = (popup: Popup): ActionProposalDTO | undefined => {
    if (popup.kind !== "alert") return undefined;
    const proposalId = alerts.find((a) => a.id === popup.alertId)?.proposalId;
    return proposalId === undefined ? undefined : proposals[proposalId];
  };

  return (
    <section className="alert-popup-stack" aria-label="Haunting alerts">
      {popups.length > 1 && (
        <div className="alert-popup-stack__bar">
          <span>{hidden > 0 ? `${hidden} older ${hidden === 1 ? "alert" : "alerts"} hidden` : `${popups.length} alerts`}</span>
          <button type="button" className="alert-popup-stack__clear" onClick={() => popups.forEach((p) => dismissPopup(p.id))}>
            Dismiss all
          </button>
        </div>
      )}
      <ul className="alert-popup-stack__list">
        {visible.map((p) => (
          <PopupItem
            key={p.id}
            popup={p}
            voice={voiceStatus[p.id]}
            proposal={proposalFor(p)}
            store={store}
            api={api}
            onDismiss={dismissPopup}
          />
        ))}
      </ul>
    </section>
  );
}

export default AlertPopupStack;
