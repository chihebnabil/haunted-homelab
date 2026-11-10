import { useState } from "react";
import { useStore } from "zustand";
import { hauntedStore, type HauntedStore } from "../state/store.js";
import "./controls.css";

export interface VoiceToggleProps {
  /** Store to read from. Defaults to the application store. */
  store?: HauntedStore;
  /**
   * Unlocks browser audio. Called inside the "Wake the ghost" click handler so
   * the browser treats it as a user gesture. When omitted, the button is not shown.
   */
  onUnlock?: () => Promise<void> | void;
}

/**
 * Voice on/off switch (Requirement 9.3, on by default) and the one-time
 * "Wake the ghost" button that unlocks audio playback.
 */
export function VoiceToggle({ store = hauntedStore, onUnlock }: VoiceToggleProps) {
  const voiceEnabled = useStore(store, (s) => s.voiceEnabled);
  const setVoiceEnabled = useStore(store, (s) => s.setVoiceEnabled);
  const [unlocked, setUnlocked] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeFailed, setWakeFailed] = useState(false);

  const wake = async () => {
    if (!onUnlock) return;
    setWaking(true);
    setWakeFailed(false);
    try {
      await onUnlock();
      setUnlocked(true);
    } catch {
      setWakeFailed(true);
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="voice-toggle">
      <label className="voice-toggle__switch">
        <input
          type="checkbox"
          role="switch"
          checked={voiceEnabled}
          aria-checked={voiceEnabled}
          onChange={(e) => setVoiceEnabled(e.target.checked)}
        />
        <span>Voice</span>
      </label>
      {onUnlock && !unlocked && (
        <button type="button" className="voice-toggle__wake" onClick={wake} disabled={waking}>
          Wake the ghost
        </button>
      )}
      {wakeFailed && (
        <span className="voice-toggle__error" role="alert">
          The ghost would not wake. Try again.
        </span>
      )}
    </div>
  );
}

export default VoiceToggle;
