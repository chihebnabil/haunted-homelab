import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronUp, CircleAlert, RotateCcw, SendHorizontal, VolumeX } from "lucide-react";
import { useStore } from "zustand";
import type { GhostReply, LogEvent } from "../../shared/types.js";
import { api as defaultApi, ApiError, type ApiClient } from "../api/rest.js";
import { hauntedStore, selectRecentTurns, type ChatEntry, type HauntedStore } from "../state/store.js";
import { ProposalCard } from "./ProposalCard.js";
import { Equalizer, GhostMark } from "./visuals.js";
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

function GhostAvatar({ speaking = false }: { speaking?: boolean }) {
  return (
    <span className={`chat-page__avatar${speaking ? " chat-page__avatar--speaking" : ""}`} aria-hidden="true">
      <GhostMark />
    </span>
  );
}

/** Long log summaries show only their most recent events until the user asks for the rest. */
export const VISIBLE_LOG_EVENTS = 5;

function LogEventList({ events }: { events: LogEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (events.length === 0) return null;
  const hiddenCount = expanded ? 0 : Math.max(0, events.length - VISIBLE_LOG_EVENTS);
  return (
    <div className="chat-page__events-wrap">
      {hiddenCount > 0 && (
        <button type="button" className="chat-page__events-more" onClick={() => setExpanded(true)}>
          <ChevronUp />
          Show {hiddenCount} earlier {hiddenCount === 1 ? "event" : "events"}
        </button>
      )}
      <ul className="chat-page__events" aria-label="Log events">
        {events.slice(hiddenCount).map((e, i) => (
          <li key={hiddenCount + i} className={`chat-page__event chat-page__event--${e.level}`}>
            {/* Local time of day reads faster; the full timestamp stays in dateTime and the tooltip. */}
            <time dateTime={e.timestamp} title={e.timestamp}>
              {formatTime(e.timestamp)}
            </time>{" "}
            <span className="chat-page__event-level">{e.level}</span>{" "}
            <span className="chat-page__event-text">{e.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface GhostEntryProps {
  reply: GhostReply;
  voiceFailed: boolean;
  speaking: boolean;
  store: HauntedStore;
  api: ApiClient;
  onReply: ((reply: GhostReply) => void) | undefined;
}

function GhostEntry({ reply, voiceFailed, speaking, store, api, onReply }: GhostEntryProps) {
  return (
    <li className="chat-page__entry chat-page__entry--ghost" data-testid="ghost-reply">
      <GhostAvatar speaking={speaking} />
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
        {(reply.createdAt || speaking || voiceFailed) && (
          <div className="chat-page__meta">
            {reply.createdAt && <time dateTime={reply.createdAt}>{formatTime(reply.createdAt)}</time>}
            {speaking && (
              <span className="chat-page__speaking">
                <Equalizer /> speaking
              </span>
            )}
            {voiceFailed && (
              <span className="chat-page__voice-failed" role="status">
                <VolumeX /> {VOICE_FAILED_TEXT}
              </span>
            )}
          </div>
        )}
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
        <GhostAvatar />
        <div>
          <h2 className="card__title">Séance</h2>
          <p className="card__subtitle">Ask the ghost about your containers, logs, and host.</p>
        </div>
      </header>

      <div className="chat-page__scroll" ref={scrollRef}>
        {showIntro && (
          <div className="chat-page__intro">
            <span className="chat-page__intro-ghost" aria-hidden="true">
              <GhostMark />
            </span>
            <p className="chat-page__intro-title">The ghost is listening</p>
            <p className="chat-page__intro-text">Ask about a container, its logs, or the host. Or try one of these:</p>
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
                speaking={voiceStatus[entry.reply.id] === "playing"}
                store={store}
                api={api}
                onReply={onReply}
              />
            ),
          )}
        </ol>

        {pending && (
          <div className="chat-page__waiting" role="status" aria-live="polite">
            <GhostAvatar />
            <span className="chat-page__waiting-bubble">
              <span className="chat-page__dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>The ghost is stirring in the wires…</span>
            </span>
          </div>
        )}

        {failed && !pending && (
          <div className="chat-page__error" role="alert">
            <CircleAlert />
            <p>{failed.error}</p>
            <button type="button" className="btn btn--sm" onClick={() => void send(failed.question)}>
              <RotateCcw />
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
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn--primary chat-page__send" disabled={pending || input.trim() === ""}>
          <SendHorizontal />
          <span className="chat-page__send-label">Send</span>
        </button>
      </form>
    </section>
  );
}
