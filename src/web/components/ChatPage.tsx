import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import type { GhostReply, LogEvent } from "../../shared/types.js";
import { api as defaultApi, ApiError, type ApiClient } from "../api/rest.js";
import { hauntedStore, selectRecentTurns, type ChatEntry, type HauntedStore } from "../state/store.js";
import { ProposalCard } from "./ProposalCard.js";
import "./ChatPage.css";

export interface ChatPageProps {
  store?: HauntedStore;
  api?: ApiClient;
  /** Called with each ghost reply returned by an HTTP response (chat answer or action result). */
  onReply?: (reply: GhostReply) => void;
}

/** Matches the server limit on question length. */
export const MAX_QUESTION_LENGTH = 2000;

/** Shown when the request timed out or failed without a persona error body (Requirement 6.7). */
export const DEFAULT_CHAT_ERROR = "The ghost's reply was lost between worlds. Your question failed to reach the other side.";
export const TIMEOUT_CHAT_ERROR = "The ghost fell silent for too long. Your question failed to reach the other side.";

export const VOICE_FAILED_TEXT = "the voice was lost in the static";

function chatErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.errorText) return err.errorText;
    if (err.kind === "timeout") return TIMEOUT_CHAT_ERROR;
  }
  return DEFAULT_CHAT_ERROR;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function LogEventList({ events }: { events: LogEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ul className="chat-page__events" aria-label="Log events">
      {events.map((e, i) => (
        <li key={i} className={`chat-page__event chat-page__event--${e.level}`}>
          <time dateTime={e.timestamp}>{e.timestamp}</time>{" "}
          <span className="chat-page__event-level">{e.level}</span>{" "}
          <span className="chat-page__event-text">{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

interface GhostEntryProps {
  reply: GhostReply;
  voiceFailed: boolean;
  store: HauntedStore;
  api: ApiClient;
  onReply: ((reply: GhostReply) => void) | undefined;
}

function GhostEntry({ reply, voiceFailed, store, api, onReply }: GhostEntryProps) {
  return (
    <li className="chat-page__entry chat-page__entry--ghost" data-testid="ghost-reply">
      <span className="chat-page__avatar" aria-hidden="true">
        👻
      </span>
      <div className="chat-page__bubble">
      <p className="chat-page__text">{reply.text}</p>
      {reply.events && <LogEventList events={reply.events} />}
      {reply.list && reply.list.length > 0 && (
        <ul className="chat-page__list" aria-label="Names">
          {reply.list.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
      )}
      {reply.proposal && <ProposalCard proposal={reply.proposal} store={store} api={api} onReply={onReply} />}
      <div className="chat-page__meta">
        {reply.createdAt && <time dateTime={reply.createdAt}>{formatTime(reply.createdAt)}</time>}
        {voiceFailed && (
          <span className="chat-page__voice-failed" role="status">
            <span aria-hidden="true">🔇</span> {VOICE_FAILED_TEXT}
          </span>
        )}
      </div>
      </div>
    </li>
  );
}

/** Chat_Page: questions, ghost replies, log events, proposals, and errors (Requirements 6.3, 6.6, 6.7, 7.2, 9.5). */
export function ChatPage({ store = hauntedStore, api = defaultApi, onReply }: ChatPageProps) {
  const entries = useStore(store, (s) => s.chat.entries);
  const pending = useStore(store, (s) => s.chat.pending);
  const failed = useStore(store, (s) => s.chat.failed);
  const voiceStatus = useStore(store, (s) => s.voiceStatus);
  const sampleContainer = useStore(store, (s) => s.snapshot?.containers[0]?.name) ?? "plex";
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Put a failed question back in the input for resubmission (Requirement 6.7).
  useEffect(() => {
    if (failed) setInput(failed.question);
  }, [failed]);

  // Keep the newest message in view by scrolling the conversation, not the whole page.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, pending, failed]);

  async function send(raw: string) {
    const question = raw.trim();
    const state = store.getState();
    if (question === "" || state.chat.pending) return;
    const history = selectRecentTurns(state, 10);
    state.submitQuestion(question);
    setInput("");
    try {
      const reply = await api.chat({ question, history });
      store.getState().receiveReply(reply);
      onReply?.(reply);
    } catch (err) {
      store.getState().failQuestion(question, chatErrorText(err));
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  const suggestions = [`Is ${sampleContainer} okay?`, `Summarize the ${sampleContainer} logs`, "How is the host doing?"];
  const showIntro = entries.length === 0 && !pending && !failed;

  return (
    <section className="chat-page card" aria-label="Chat with the ghost">
      <header className="card__header chat-page__header">
        <div>
          <h2 className="card__title">Séance</h2>
          <p className="card__subtitle">Ask the ghost about your containers, logs, and host.</p>
        </div>
      </header>

      <div className="chat-page__scroll" ref={scrollRef}>
        {showIntro && (
          <div className="chat-page__intro">
            <span className="chat-page__intro-ghost" aria-hidden="true">
              👻
            </span>
            <p className="chat-page__intro-text">The ghost is listening. Ask it something, or try one of these:</p>
            <div className="chat-page__suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chat-page__suggestion" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <ol className="chat-page__entries">
          {entries.map((entry: ChatEntry) =>
            entry.kind === "user" ? (
              <li key={entry.id} className="chat-page__entry chat-page__entry--user" data-testid="user-question">
                <p className="chat-page__text">{entry.text}</p>
              </li>
            ) : (
              <GhostEntry
                key={entry.id}
                reply={entry.reply}
                voiceFailed={voiceStatus[entry.reply.id] === "failed"}
                store={store}
                api={api}
                onReply={onReply}
              />
            ),
          )}
        </ol>

        {pending && (
          <p className="chat-page__waiting" role="status" aria-live="polite">
            <span className="chat-page__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            The ghost is stirring in the wires…
          </p>
        )}

        {failed && !pending && (
          <div className="chat-page__error" role="alert">
            <p>{failed.error}</p>
            <button type="button" className="btn btn--sm" onClick={() => void send(failed.question)}>
              Retry
            </button>
          </div>
        )}
      </div>

      <form className="chat-page__form" onSubmit={onSubmit}>
        <input
          type="text"
          className="text-input chat-page__input"
          aria-label="Ask the ghost"
          placeholder={`Is ${sampleContainer} feeling okay?`}
          value={input}
          maxLength={MAX_QUESTION_LENGTH}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={pending || input.trim() === ""}>
          Send
        </button>
      </form>
    </section>
  );
}
