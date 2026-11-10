import { ShieldCheck } from "lucide-react";
import { useStore } from "zustand";
import { hauntedStore, type HauntedStore } from "../state/store.js";
import "./controls.css";

export interface PrivacyNoticeProps {
  /** Store to read from. Defaults to the application store. */
  store?: HauntedStore;
}

/** Text of the notice. Generic until the public config has loaded (Requirement 13.3). */
export function privacyNoticeText(models?: { llmModel: string; ttsModel: string }): string {
  if (!models) {
    return "System data (metrics, container names, log excerpts) is sent to OpenRouter and the upstream providers of the configured AI models.";
  }
  return (
    `System data (metrics, container names, log excerpts) is sent to OpenRouter and the providers of ` +
    `${models.llmModel} (LLM) and ${models.ttsModel} (text-to-speech).`
  );
}

/** Persistent footer naming OpenRouter and the configured LLM and TTS model slugs. */
export function PrivacyNotice({ store = hauntedStore }: PrivacyNoticeProps) {
  const config = useStore(store, (s) => s.publicConfig);
  return (
    <footer className="privacy-notice" aria-label="Privacy notice">
      <p>
        <ShieldCheck />
        <span>{privacyNoticeText(config)}</span>
      </p>
    </footer>
  );
}

export default PrivacyNotice;
