/**
 * Bounded store of spoken texts (ghost replies, alert messages, recovery messages) keyed by message id.
 *
 * The speech route looks up text here by id, so the browser can only ask the server to speak text the
 * server itself produced (design decision 4, Requirement 13.2). Each entry can also hold the synthesized
 * audio so repeated playback does not call the TTS provider again.
 *
 * Only the `capacity` most recently stored texts are kept. Storing a new text beyond capacity evicts the
 * oldest entry together with its cached audio.
 */

import type { TtsAudio } from "../tts/TtsClient.js";

export const DEFAULT_MESSAGE_CAPACITY = 500;

interface Entry {
  text: string;
  audio?: TtsAudio;
}

export class MessageStore {
  readonly capacity: number;
  // Map iteration order is insertion order, so the first key is always the oldest entry.
  readonly #entries = new Map<string, Entry>();

  constructor(capacity: number = DEFAULT_MESSAGE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`MessageStore capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  /**
   * Stores `text` under `id` as the most recent entry. Storing an existing id moves it to the most recent
   * position. Cached audio is kept only when the text is unchanged, because audio must match its text.
   */
  put(id: string, text: string): void {
    const existing = this.#entries.get(id);
    this.#entries.delete(id);
    const entry: Entry = { text };
    if (existing?.audio !== undefined && existing.text === text) entry.audio = existing.audio;
    this.#entries.set(id, entry);
    this.#evictOverflow();
  }

  getText(id: string): string | undefined {
    return this.#entries.get(id)?.text;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  getAudio(id: string): TtsAudio | undefined {
    return this.#entries.get(id)?.audio;
  }

  /**
   * Caches audio for a stored text. Returns false and caches nothing when the id is unknown or was evicted,
   * so audio never exists without its text.
   */
  setAudio(id: string, audio: TtsAudio): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    entry.audio = audio;
    return true;
  }

  get size(): number {
    return this.#entries.size;
  }

  #evictOverflow(): void {
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.delete(oldest.value);
    }
  }
}
