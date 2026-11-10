import { describe, expect, it } from "vitest";
import { DEFAULT_MESSAGE_CAPACITY, MessageStore } from "../../../src/server/messages/MessageStore.js";
import type { TtsAudio } from "../../../src/server/tts/TtsClient.js";

const audio = (s: string): TtsAudio => ({ audio: Buffer.from(s), mimeType: "audio/mpeg" });

describe("MessageStore", () => {
  it("stores and returns text and audio by id", () => {
    const store = new MessageStore();
    store.put("a", "The spirit of plex stirs.");
    expect(store.getText("a")).toBe("The spirit of plex stirs.");
    expect(store.getAudio("a")).toBeUndefined();

    const clip = audio("mp3-bytes");
    expect(store.setAudio("a", clip)).toBe(true);
    expect(store.getAudio("a")).toBe(clip);
  });

  it("returns undefined for unknown ids and refuses audio without text", () => {
    const store = new MessageStore();
    expect(store.getText("missing")).toBeUndefined();
    expect(store.has("missing")).toBe(false);
    expect(store.setAudio("missing", audio("x"))).toBe(false);
    expect(store.getAudio("missing")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("defaults to a capacity of 500 and evicts the oldest text with its audio", () => {
    const store = new MessageStore();
    expect(store.capacity).toBe(DEFAULT_MESSAGE_CAPACITY);
    expect(DEFAULT_MESSAGE_CAPACITY).toBe(500);

    store.put("m0", "text 0");
    store.setAudio("m0", audio("clip 0"));
    for (let i = 1; i < 500; i++) store.put(`m${i}`, `text ${i}`);
    expect(store.size).toBe(500);
    expect(store.getText("m0")).toBe("text 0");

    store.put("m500", "text 500");
    expect(store.size).toBe(500);
    expect(store.has("m0")).toBe(false);
    expect(store.getText("m0")).toBeUndefined();
    expect(store.getAudio("m0")).toBeUndefined();
    expect(store.setAudio("m0", audio("late"))).toBe(false);
    expect(store.getText("m1")).toBe("text 1");
    expect(store.getText("m500")).toBe("text 500");
  });

  it("honors a custom capacity", () => {
    const store = new MessageStore(2);
    store.put("a", "1");
    store.put("b", "2");
    store.put("c", "3");
    expect([store.has("a"), store.has("b"), store.has("c")]).toEqual([false, true, true]);
  });

  it("re-storing an id makes it most recent and drops audio only when the text changes", () => {
    const store = new MessageStore(2);
    store.put("a", "same");
    store.setAudio("a", audio("clip"));
    store.put("b", "other");

    store.put("a", "same");
    expect(store.getAudio("a")).toBeDefined();

    store.put("c", "new");
    expect(store.has("b")).toBe(false);
    expect(store.has("a")).toBe(true);

    store.put("a", "changed");
    expect(store.getText("a")).toBe("changed");
    expect(store.getAudio("a")).toBeUndefined();
  });

  it("rejects invalid capacities", () => {
    expect(() => new MessageStore(0)).toThrow(RangeError);
    expect(() => new MessageStore(-1)).toThrow(RangeError);
    expect(() => new MessageStore(1.5)).toThrow(RangeError);
  });
});
