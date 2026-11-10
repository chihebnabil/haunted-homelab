/**
 * FIFO queue of spoken messages (Requirements 5.3, 9.1, 9.4, 9.5).
 *
 * - Clips play one at a time, in enqueue order. A clip is fetched only when it
 *   reaches the head of the queue, so at most one fetch or one playback is in
 *   flight at any moment.
 * - Each fetch is aborted after `fetchTimeoutMs` (15 s by default). A failed or
 *   timed-out fetch, or a failed playback, calls `onFailure(id)` and the queue
 *   moves on to the next clip.
 * - Every object URL obtained from `fetchAudio` is revoked once it is no longer
 *   needed (after playback, after a failed playback, or when it arrives late).
 * - `clear()` drops pending clips, aborts the in-flight fetch, and stops the
 *   player without reporting failures. Callbacks from the cleared clip are
 *   ignored.
 */

/** Plays one audio source. `play` resolves when playback ends and rejects on a playback error. */
export interface Player {
  play(src: string): Promise<void>;
  /** Stops the current playback. A pending `play` promise should settle (resolve) promptly. */
  stop(): void;
}

/** Fetches audio for a message and returns an object URL. Must honour `signal`. */
export type FetchAudio = (messageId: string, signal: AbortSignal) => Promise<string>;

export interface AudioQueueOptions {
  /** Fetch timeout in milliseconds. Default 15000 (Requirement 9.5). */
  fetchTimeoutMs?: number;
  /** Releases an object URL. Default `URL.revokeObjectURL` when available. */
  revokeUrl?: (url: string) => void;
}

export const AUDIO_FETCH_TIMEOUT_MS = 15_000;

export class AudioFetchTimeoutError extends Error {
  constructor(readonly messageId: string, readonly timeoutMs: number) {
    super(`Audio fetch for ${messageId} timed out after ${timeoutMs} ms`);
    this.name = "AudioFetchTimeoutError";
  }
}

export type AudioQueuePhase = "fetching" | "playing";

export interface AudioQueueStatus {
  current: { id: string; phase: AudioQueuePhase } | null;
  pending: string[];
}

interface Slot {
  id: string;
  phase: AudioQueuePhase;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  url: string | undefined;
}

function defaultRevoke(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

export class AudioQueue {
  private readonly pending: string[] = [];
  private current: Slot | null = null;
  private readonly fetchTimeoutMs: number;
  private readonly revokeUrl: (url: string) => void;

  constructor(
    private readonly player: Player,
    private readonly fetchAudio: FetchAudio,
    private readonly onFailure: (id: string) => void,
    options: AudioQueueOptions = {},
  ) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? AUDIO_FETCH_TIMEOUT_MS;
    this.revokeUrl = options.revokeUrl ?? defaultRevoke;
  }

  enqueue(messageId: string): void {
    this.pending.push(messageId);
    this.next();
  }

  /** Drops every pending clip and stops the current one. No failures are reported. */
  clear(): void {
    this.pending.length = 0;
    const slot = this.current;
    if (!slot) return;
    this.current = null;
    clearTimeout(slot.timer);
    if (slot.phase === "fetching") {
      slot.controller.abort();
    } else {
      this.player.stop();
    }
    this.release(slot);
  }

  status(): AudioQueueStatus {
    return {
      current: this.current ? { id: this.current.id, phase: this.current.phase } : null,
      pending: [...this.pending],
    };
  }

  private next(): void {
    if (this.current) return;
    const id = this.pending.shift();
    if (id === undefined) return;

    const slot: Slot = {
      id,
      phase: "fetching",
      controller: new AbortController(),
      timer: undefined,
      url: undefined,
    };
    this.current = slot;

    slot.timer = setTimeout(() => {
      if (this.current !== slot || slot.phase !== "fetching") return;
      slot.controller.abort(new AudioFetchTimeoutError(id, this.fetchTimeoutMs));
      this.finish(slot, true);
    }, this.fetchTimeoutMs);

    let fetched: Promise<string>;
    try {
      fetched = this.fetchAudio(id, slot.controller.signal);
    } catch (err) {
      fetched = Promise.reject(err);
    }

    fetched.then(
      (url) => this.onFetched(slot, url),
      () => {
        clearTimeout(slot.timer);
        if (this.current === slot && slot.phase === "fetching") this.finish(slot, true);
      },
    );
  }

  private onFetched(slot: Slot, url: string): void {
    clearTimeout(slot.timer);
    if (this.current !== slot || slot.phase !== "fetching") {
      // Cleared or timed out while fetching: the clip will never play.
      this.revokeUrl(url);
      return;
    }
    slot.phase = "playing";
    slot.url = url;

    let played: Promise<void>;
    try {
      played = this.player.play(url);
    } catch (err) {
      played = Promise.reject(err);
    }
    played.then(
      () => this.finish(slot, false),
      () => this.finish(slot, true),
    );
  }

  private finish(slot: Slot, failed: boolean): void {
    this.release(slot);
    if (this.current !== slot) return;
    this.current = null;
    try {
      if (failed) this.onFailure(slot.id);
    } finally {
      this.next();
    }
  }

  private release(slot: Slot): void {
    if (slot.url === undefined) return;
    const url = slot.url;
    slot.url = undefined;
    this.revokeUrl(url);
  }
}

export class AudioPlaybackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioPlaybackError";
  }
}

/**
 * `Player` backed by a single reused `HTMLAudioElement`. Reusing one element
 * means that once `unlock()` has run inside a user gesture, later programmatic
 * playback is allowed by the browser's autoplay policy.
 */
export class HtmlAudioPlayer implements Player {
  private readonly audio: HTMLAudioElement;
  private settleCurrent: (() => void) | null = null;

  constructor(audio?: HTMLAudioElement) {
    this.audio = audio ?? new Audio();
    this.audio.preload = "auto";
  }

  play(src: string): Promise<void> {
    this.stop();
    const audio = this.audio;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const cleanup = (): void => {
        done = true;
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        if (this.settleCurrent === settle) this.settleCurrent = null;
      };
      const settle = (): void => {
        if (done) return;
        cleanup();
        resolve();
      };
      const fail = (err: unknown): void => {
        if (done) return;
        cleanup();
        reject(err instanceof Error ? err : new AudioPlaybackError(String(err)));
      };
      const onEnded = (): void => settle();
      const onError = (): void =>
        fail(new AudioPlaybackError(audio.error?.message || "Audio playback failed"));

      this.settleCurrent = settle;
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.src = src;
      try {
        Promise.resolve(audio.play()).catch(fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  stop(): void {
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    try {
      this.audio.pause();
    } catch {
      // Some environments do not implement media playback.
    }
    this.audio.removeAttribute("src");
    settle?.();
  }

  /**
   * Plays a short silent clip. Call from a user gesture handler (the
   * "Wake the ghost" button) so the browser allows later playback.
   */
  async unlock(): Promise<void> {
    if (this.settleCurrent) return; // already playing, so already unlocked
    const audio = this.audio;
    audio.src = silentWavDataUri();
    try {
      await audio.play();
    } finally {
      try {
        audio.pause();
      } catch {
        // ignore
      }
      audio.removeAttribute("src");
    }
  }
}

let silentWav: string | undefined;

/** 0.1 s of 8-bit mono silence at 8 kHz as a WAV data URI. */
export function silentWavDataUri(): string {
  if (silentWav) return silentWav;
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit PCM silence
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  silentWav = `data:audio/wav;base64,${btoa(binary)}`;
  return silentWav;
}
