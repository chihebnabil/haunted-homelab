import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  connectSocket,
  parseServerEvent,
  socketUrl,
  type WebSocketLike,
} from "../../../src/web/api/socket.js";
import type { ServerEvent } from "../../../src/shared/types.js";

class FakeSocket implements WebSocketLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  open(): void {
    this.onopen?.(new Event("open"));
  }
  message(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  drop(): void {
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close"));
  }
  close(): void {
    this.closed = true;
  }
}

let sockets: FakeSocket[];
const create = (url: string) => {
  const s = new FakeSocket(url);
  sockets.push(s);
  return s;
};

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("socketUrl", () => {
  it("uses ws for http and wss for https with the page host", () => {
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:3000" })).toBe("ws://127.0.0.1:3000/ws");
    expect(socketUrl({ protocol: "https:", host: "ghost.local" })).toBe("wss://ghost.local/ws");
  });

  it("defaults to the jsdom location", () => {
    connectSocket({ onEvent: () => {}, createWebSocket: create });
    expect(sockets[0]?.url).toBe(socketUrl(window.location));
  });
});

describe("backoffDelay", () => {
  it("doubles from 1 s and caps at 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((n) => backoffDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 10000, 10000, 10000,
    ]);
  });
});

describe("parseServerEvent", () => {
  it("accepts known event types and rejects malformed data", () => {
    const ev: ServerEvent = { type: "proposal.updated", proposal: {} as never };
    expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
    expect(parseServerEvent("not json")).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseServerEvent(JSON.stringify(null))).toBeNull();
    expect(parseServerEvent(42)).toBeNull();
  });
});

describe("connectSocket", () => {
  it("delivers parsed events and reports open and close", () => {
    const events: ServerEvent[] = [];
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const conn = connectSocket({ url: "ws://x/ws", onEvent: (e) => events.push(e), onOpen, onClose, createWebSocket: create });

    sockets[0]!.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(conn.connected).toBe(true);

    const snapshot: ServerEvent = {
      type: "snapshot",
      snapshot: {
        readAt: "2024-01-01T00:00:00.000Z",
        containers: [],
        host: { cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, filesystems: [] },
      },
    };
    sockets[0]!.message(JSON.stringify(snapshot));
    sockets[0]!.message("garbage");
    expect(events).toEqual([snapshot]);

    sockets[0]!.drop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.connected).toBe(false);
  });

  it("reconnects with exponential backoff and resets after a successful open", () => {
    const onClose = vi.fn();
    connectSocket({ url: "ws://x/ws", onEvent: () => {}, onClose, createWebSocket: create });

    // Failed attempts: delays 1 s, 2 s, 4 s.
    for (const delay of [1000, 2000, 4000]) {
      sockets.at(-1)!.drop();
      const before = sockets.length;
      vi.advanceTimersByTime(delay - 1);
      expect(sockets.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(before + 1);
    }
    expect(onClose).toHaveBeenCalledTimes(3);

    // A successful open resets the backoff to 1 s.
    sockets.at(-1)!.open();
    sockets.at(-1)!.drop();
    const before = sockets.length;
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(before + 1);
  });

  it("caps the reconnect delay at 10 s", () => {
    connectSocket({ url: "ws://x/ws", onEvent: () => {}, createWebSocket: create });
    for (let i = 0; i < 6; i++) {
      sockets.at(-1)!.drop();
      vi.advanceTimersByTime(10_000);
    }
    expect(sockets.length).toBe(7);
    sockets.at(-1)!.drop();
    const before = sockets.length;
    vi.advanceTimersByTime(9_999);
    expect(sockets.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(before + 1);
  });

  it("close() stops reconnecting and closes the current socket", () => {
    const conn = connectSocket({ url: "ws://x/ws", onEvent: () => {}, createWebSocket: create });
    sockets[0]!.drop();
    conn.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(1);

    const conn2 = connectSocket({ url: "ws://x/ws", onEvent: () => {}, createWebSocket: create });
    const s = sockets.at(-1)!;
    s.open();
    conn2.close();
    expect(s.closed).toBe(true);
    expect(conn2.connected).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(sockets.at(-1)).toBe(s);
  });
});
