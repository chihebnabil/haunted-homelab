import { describe, expect, it } from "vitest";
import { CHAT_HISTORY_KEY, loadHistory, saveHistory, type HistoryStorage } from "../../src/web/state/chatHistory.js";

function memoryStorage(): HistoryStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("chat history", () => {
  it("round-trips turns under haunted.chat.v1", () => {
    const storage = memoryStorage();
    const turns = [
      { role: "user" as const, text: "Is plex okay?" },
      { role: "ghost" as const, text: "plex rests easy." },
    ];
    saveHistory(turns, storage);
    expect(storage.data.has(CHAT_HISTORY_KEY)).toBe(true);
    expect(loadHistory(storage)).toEqual(turns);
  });

  it("returns an empty list when nothing is stored or data is corrupt", () => {
    const storage = memoryStorage();
    expect(loadHistory(storage)).toEqual([]);
    storage.data.set(CHAT_HISTORY_KEY, "{not json");
    expect(loadHistory(storage)).toEqual([]);
    storage.data.set(CHAT_HISTORY_KEY, JSON.stringify({ role: "user", text: "x" }));
    expect(loadHistory(storage)).toEqual([]);
    storage.data.set(CHAT_HISTORY_KEY, JSON.stringify([{ role: "admin", text: "x" }]));
    expect(loadHistory(storage)).toEqual([]);
  });

  it("ignores storage that throws", () => {
    const broken: HistoryStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveHistory([{ role: "user", text: "x" }], broken)).not.toThrow();
    expect(loadHistory(broken)).toEqual([]);
  });

  it("uses sessionStorage by default", () => {
    sessionStorage.clear();
    saveHistory([{ role: "ghost", text: "boo" }]);
    expect(sessionStorage.getItem(CHAT_HISTORY_KEY)).not.toBeNull();
    expect(loadHistory()).toEqual([{ role: "ghost", text: "boo" }]);
  });
});
