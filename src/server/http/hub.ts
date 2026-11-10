import type { ServerEvent } from "../../shared/types.js";

/** Sends server-to-client events to every connected Web_App. */
export interface WsHub {
  broadcast(event: ServerEvent): void;
}
