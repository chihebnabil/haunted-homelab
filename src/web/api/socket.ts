/**
 * Reconnecting WebSocket client for server events (Requirements 10.3, 10.5).
 * Reconnects with exponential backoff from 1 s to 10 s. The WebSocket constructor is injectable for tests.
 */
import type { ServerEvent, ServerEventType } from "../../shared/types.js";

export const MIN_RECONNECT_DELAY_MS = 1_000;
export const MAX_RECONNECT_DELAY_MS = 10_000;

const EVENT_TYPES: ReadonlySet<ServerEventType> = new Set<ServerEventType>([
  "snapshot",
  "alert.raised",
  "alert.resolved",
  "proposal.updated",
  "chat.message",
]);

/** The subset of the browser WebSocket that this client uses. */
export interface WebSocketLike {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SocketOptions {
  onEvent: (event: ServerEvent) => void;
  /** Called on every successful connection, including reconnects. */
  onOpen?: () => void;
  /** Called on every close of the underlying socket, including failed connection attempts. */
  onClose?: () => void;
  /** Defaults to `socketUrl(location)`. */
  url?: string;
  /** Defaults to `new WebSocket(url)`. */
  createWebSocket?: WebSocketFactory;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface SocketConnection {
  /** Stops reconnecting and closes the current socket. */
  close(): void;
  readonly connected: boolean;
}

/** `ws:` or `wss:` matching the page protocol, the page host, and `/ws`. */
export function socketUrl(loc: Pick<Location, "protocol" | "host">): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/ws`;
}

/** Delay before reconnect attempt `attempt` (0-based): min · 2^attempt, capped at max. */
export function backoffDelay(
  attempt: number,
  minDelayMs = MIN_RECONNECT_DELAY_MS,
  maxDelayMs = MAX_RECONNECT_DELAY_MS,
): number {
  return Math.min(maxDelayMs, minDelayMs * 2 ** Math.max(0, attempt));
}

/** Parses a WebSocket message into a ServerEvent, or returns null for malformed data. */
export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type as ServerEventType)) return null;
  return parsed as ServerEvent;
}

export function connectSocket(opts: SocketOptions): SocketConnection {
  const url = opts.url ?? socketUrl(globalThis.location);
  const create: WebSocketFactory = opts.createWebSocket ?? ((u) => new WebSocket(u));
  const minDelay = opts.minDelayMs ?? MIN_RECONNECT_DELAY_MS;
  const maxDelay = opts.maxDelayMs ?? MAX_RECONNECT_DELAY_MS;

  let ws: WebSocketLike | null = null;
  let attempt = 0;
  let connected = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = backoffDelay(attempt, minDelay, maxDelay);
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
  }

  function open(): void {
    if (stopped) return;
    let socket: WebSocketLike;
    try {
      socket = create(url);
    } catch {
      opts.onClose?.();
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      connected = true;
      attempt = 0;
      opts.onOpen?.();
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      const event = parseServerEvent(ev.data);
      if (event) opts.onEvent(event);
    };
    // Browsers fire `close` after `error`, so reconnect is handled only in onclose.
    socket.onerror = () => {};
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      connected = false;
      opts.onClose?.();
      scheduleReconnect();
    };
  }

  open();

  return {
    close() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const socket = ws;
      ws = null;
      connected = false;
      socket?.close();
    },
    get connected() {
      return connected;
    },
  };
}
