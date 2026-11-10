import type { ChatTurn } from "../../shared/types.js";

/** sessionStorage key for the Chat_Page conversation (Requirement 6.8). */
export const CHAT_HISTORY_KEY = "haunted.chat.v1";

/** Minimal subset of the DOM `Storage` interface, so tests can pass an in-memory stub. */
export type HistoryStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): HistoryStorage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    // Some browsers throw a SecurityError when storage access is blocked.
    return undefined;
  }
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.role === "user" || v.role === "ghost") && typeof v.text === "string";
}

/**
 * Saves the conversation for the current browser session.
 * Storage failures (quota exceeded, storage disabled) are ignored: history is a convenience.
 */
export function saveHistory(turns: readonly ChatTurn[], storage: HistoryStorage | undefined = defaultStorage()): void {
  if (!storage) return;
  const plain = turns.map((t) => ({ role: t.role, text: t.text }));
  try {
    storage.setItem(CHAT_HISTORY_KEY, JSON.stringify(plain));
  } catch {
    // ignore
  }
}

/**
 * Loads the conversation saved by `saveHistory`.
 * Returns an empty list when nothing is stored, the data is not valid JSON, or it is not a list of turns.
 */
export function loadHistory(storage: HistoryStorage | undefined = defaultStorage()): ChatTurn[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(CHAT_HISTORY_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every(isChatTurn)) return [];
  return parsed.map((t) => ({ role: t.role, text: t.text }));
}
