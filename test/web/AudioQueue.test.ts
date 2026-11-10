import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioQueue,
  HtmlAudioPlayer,
  silentWavDataUri,
  type Player,
} from "../../src/web/audio/AudioQueue.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Fake player: each play() returns a deferred the test settles. */
function fakePlayer() {
  const plays: { src: string; d: Deferred<void> }[] = [];
  let active = 0;
  let maxActive = 0;
  const player: Player = {
    play: (src) => {
      const d = deferred<void>();
      plays.push({ src, d });
      active++;
      maxActive = Math.max(maxActive, active);
      d.promise.then(
        () => active--,
        () => active--,
      );
      return d.promise;
    },
    stop: vi.fn(() => plays.at(-1)?.d.resolve()),
  };
  return { player, plays, maxActive: () => maxActive };
}

/** Fake fetch: each call returns a deferred the test settles. */
function fakeFetch() {
  const calls = new Map<string, { d: Deferred<string>; signal: AbortSignal }>();
  const fetchAudio = (id: string, signal: AbortSignal) => {
    const d = deferred<string>();
    calls.set(id, { d, signal });
    return d.promise;
  };
  return { fetchAudio, calls };
}

function setup() {
  const p = fakePlayer();
  const f = fakeFetch();
  const failures: string[] = [];
  const revoked: string[] = [];
  const queue = new AudioQueue(p.player, f.fetchAudio, (id) => failures.push(id), {
    revokeUrl: (u) => revoked.push(u),
  });
  return { ...p, ...f, failures, revoked, queue };
}

describe("AudioQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("plays clips one at a time in enqueue order and revokes URLs after playback", async () => {
    const t = setup();
    t.queue.enqueue("a");
    t.queue.enqueue("b");
    expect([...t.calls.keys()]).toEqual(["a"]); // b is not fetched until a ends

    t.calls.get("a")!.d.resolve("blob:a");
    await flush();
    expect(t.plays.map((p) => p.src)).toEqual(["blob:a"]);
    expect(t.queue.status()).toEqual({ current: { id: "a", phase: "playing" }, pending: ["b"] });

    t.plays[0]!.d.resolve();
    await flush();
    expect(t.revoked).toEqual(["blob:a"]);
    t.calls.get("b")!.d.resolve("blob:b");
    await flush();
    t.plays[1]!.d.resolve();
    await flush();

    expect(t.plays.map((p) => p.src)).toEqual(["blob:a", "blob:b"]);
    expect(t.revoked).toEqual(["blob:a", "blob:b"]);
    expect(t.maxActive()).toBe(1);
    expect(t.failures).toEqual([]);
    expect(t.queue.status()).toEqual({ current: null, pending: [] });
  });

  it("reports a failed fetch and moves on to the next clip", async () => {
    const t = setup();
    t.queue.enqueue("a");
    t.queue.enqueue("b");
    t.calls.get("a")!.d.reject(new Error("502"));
    await flush();

    expect(t.failures).toEqual(["a"]);
    expect(t.calls.has("b")).toBe(true);
    expect(t.queue.status().current).toEqual({ id: "b", phase: "fetching" });
  });

  it("aborts a fetch after 15 seconds, reports it, and revokes a late URL", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.queue.enqueue("a");
    t.queue.enqueue("b");
    const { signal, d } = t.calls.get("a")!;

    await vi.advanceTimersByTimeAsync(14_999);
    expect(t.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(t.failures).toEqual(["a"]);
    expect(t.queue.status().current).toEqual({ id: "b", phase: "fetching" });

    d.resolve("blob:late");
    await flushMicrotasks();
    expect(t.revoked).toEqual(["blob:late"]);
    expect(t.plays).toEqual([]);
  });

  it("reports a playback error, revokes the URL, and moves on", async () => {
    const t = setup();
    t.queue.enqueue("a");
    t.queue.enqueue("b");
    t.calls.get("a")!.d.resolve("blob:a");
    await flush();
    t.plays[0]!.d.reject(new Error("decode error"));
    await flush();

    expect(t.failures).toEqual(["a"]);
    expect(t.revoked).toEqual(["blob:a"]);
    expect(t.calls.has("b")).toBe(true);
  });

  it("treats a synchronous player error as a playback failure", async () => {
    const f = fakeFetch();
    const failures: string[] = [];
    const player: Player = {
      play: () => {
        throw new Error("NotAllowedError");
      },
      stop: () => {},
    };
    const queue = new AudioQueue(player, f.fetchAudio, (id) => failures.push(id), {
      revokeUrl: () => {},
    });
    queue.enqueue("a");
    f.calls.get("a")!.d.resolve("blob:a");
    await flush();
    expect(failures).toEqual(["a"]);
    expect(queue.status().current).toBeNull();
  });

  it("clear() stops playback, drops pending clips, and reports no failures", async () => {
    const t = setup();
    t.queue.enqueue("a");
    t.queue.enqueue("b");
    t.calls.get("a")!.d.resolve("blob:a");
    await flush();

    t.queue.clear();
    await flush();
    expect(t.player.stop).toHaveBeenCalledTimes(1);
    expect(t.revoked).toEqual(["blob:a"]);
    expect(t.queue.status()).toEqual({ current: null, pending: [] });
    expect(t.calls.has("b")).toBe(false);
    expect(t.failures).toEqual([]);

    t.queue.enqueue("c");
    expect(t.queue.status().current).toEqual({ id: "c", phase: "fetching" });
  });

  it("clear() while fetching aborts the fetch and ignores its late result", async () => {
    const t = setup();
    t.queue.enqueue("a");
    const { signal, d } = t.calls.get("a")!;
    t.queue.clear();
    expect(signal.aborted).toBe(true);

    d.resolve("blob:a");
    await flush();
    expect(t.plays).toEqual([]);
    expect(t.revoked).toEqual(["blob:a"]);
    expect(t.failures).toEqual([]);
  });
});

describe("HtmlAudioPlayer", () => {
  function element() {
    const audio = document.createElement("audio");
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    vi.spyOn(audio, "pause").mockImplementation(() => {});
    return { audio, play };
  }

  it("resolves when the clip ends", async () => {
    const { audio, play } = element();
    const player = new HtmlAudioPlayer(audio);
    const done = player.play("blob:a");
    expect(audio.getAttribute("src")).toBe("blob:a");
    expect(play).toHaveBeenCalled();
    audio.dispatchEvent(new Event("ended"));
    await expect(done).resolves.toBeUndefined();
  });

  it("rejects on a media error or a rejected play()", async () => {
    const { audio, play } = element();
    const player = new HtmlAudioPlayer(audio);
    const errored = player.play("blob:a");
    audio.dispatchEvent(new Event("error"));
    await expect(errored).rejects.toThrow();

    play.mockRejectedValueOnce(new Error("NotAllowedError"));
    await expect(player.play("blob:b")).rejects.toThrow("NotAllowedError");
  });

  it("stop() settles the pending play promise and clears the source", async () => {
    const { audio } = element();
    const player = new HtmlAudioPlayer(audio);
    const done = player.play("blob:a");
    player.stop();
    await expect(done).resolves.toBeUndefined();
    expect(audio.hasAttribute("src")).toBe(false);
  });

  it("unlock() plays a silent clip", async () => {
    const { audio, play } = element();
    await new HtmlAudioPlayer(audio).unlock();
    expect(play).toHaveBeenCalledTimes(1);
    expect(silentWavDataUri()).toMatch(/^data:audio\/wav;base64,UklGR/);
  });
});
