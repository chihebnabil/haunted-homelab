import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ServerEvent } from "../../shared/types.js";
import type { Logger } from "../logging/logger.js";
import type { WsHub } from "./hub.js";

export const WS_PATH = "/ws";

/**
 * WebSocket hub on `@fastify/websocket` (Requirement 10.3). Clients only receive events; incoming
 * messages are ignored. The origin check on upgrade is done by the app-wide `onRequest` guard.
 */
export class WebSocketHub implements WsHub {
  readonly #clients = new Set<WebSocket>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** Registers the `/ws` route. `@fastify/websocket` must already be registered on `app`. */
  register(app: FastifyInstance): void {
    app.get(WS_PATH, { websocket: true }, (socket) => {
      this.#clients.add(socket);
      socket.on("close", () => this.#clients.delete(socket));
      socket.on("error", (err) => {
        this.#logger.warn({ err }, "websocket client error");
        this.#clients.delete(socket);
      });
    });
  }

  broadcast(event: ServerEvent): void {
    if (this.#clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const socket of this.#clients) {
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(data, (err) => {
        if (err) this.#logger.warn({ err }, "websocket send failed");
      });
    }
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  closeAll(): void {
    for (const socket of this.#clients) socket.close(1001, "server shutting down");
    this.#clients.clear();
  }
}
