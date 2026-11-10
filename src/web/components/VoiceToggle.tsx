import { useState } from "react";
import { Sparkles, Volume2, VolumeX } from "lucide-react";
import { useStore } from "zustand";
import { hauntedStore, type HauntedStore } from "../state/store.js";
import { Equalizer } from "./visuals.js";
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
 * "Wake the ghost" button that unlocks audio playback. While a clip plays,
 * the speaker icon becomes an equalizer.
 */
export function VoiceToggle({ store = hauntedStore, onUnlock }: VoiceToggleProps) {
  const voiceEnabled = useStore(store, (s) => s.voiceEnabled);
  const setVoiceEnabled = useStore(store, (s) => s.setVoiceEnabled);
  const speaking = useStore(store, (s) => s.voiceEnabled && Object.values(s.voiceStatus).includes("playing"));
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
      <label
        className={`voice-toggle__switch${speaking ? " voice-toggle__switch--speaking" : ""}`}
        title={voiceEnabled ? "The ghost speaks replies and alerts aloud" : "The ghost stays silent"}
      >
        <span className="voice-toggle__icon" aria-hidden="true">
          {speaking ? <Equalizer /> : voiceEnabled ? <Volume2 /> : <VolumeX />}
        </span>
        <span className="voice-toggle__label">Voice</span>
        <input
          type="checkbox"
          role="switch"
          checked={voiceEnabled}
          aria-checked={voiceEnabled}
          onChange={(e) => setVoiceEnabled(e.target.checked)}
        />
      </label>
      {onUnlock && !unlocked && (
        <button
          type="button"
          className="btn btn--primary btn--sm voice-toggle__wake"
          onClick={wake}
          disabled={waking}
          title="Browsers keep a page silent until you click it once. This lets the ghost speak."
        >
          <Sparkles />
          <span className="voice-toggle__wake-label">Wake the ghost</span>
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
