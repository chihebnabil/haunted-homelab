import { useStore } from "zustand";
import { hauntedStore, type HauntedStore, type Popup, type VoiceStatus } from "../state/store.js";
import "./AlertPopupStack.css";

export interface AlertPopupStackProps {
  /** Store to read from. Defaults to the application store. */
  store?: HauntedStore;
}

/** Formats an ISO time as local time of day. Falls back to the raw string when it does not parse. */
export function formatPopupTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function popupTitle(popup: Popup): string {
  if (popup.kind === "recovery") return "Recovered";
  return popup.severity === "critical" ? "Critical haunting" : "Warning";
}

function PopupItem(props: { popup: Popup; voice: VoiceStatus | undefined; onDismiss: (id: string) => void }) {
  const { popup, voice, onDismiss } = props;
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
export function AlertPopupStack({ store = hauntedStore }: AlertPopupStackProps) {
  const popups = useStore(store, (s) => s.popups);
  const voiceStatus = useStore(store, (s) => s.voiceStatus);
  const dismissPopup = useStore(store, (s) => s.dismissPopup);

  if (popups.length === 0) return null;

  return (
    <section className="alert-popup-stack" aria-label="Haunting alerts">
      <ul className="alert-popup-stack__list">
        {popups.map((p) => (
          <PopupItem key={p.id} popup={p} voice={voiceStatus[p.id]} onDismiss={dismissPopup} />
        ))}
      </ul>
    </section>
  );
}

export default AlertPopupStack;
