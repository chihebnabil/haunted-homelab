/**
 * Cross-site request guard (design decision 6, Requirement 12.4).
 *
 * POST and DELETE requests and WebSocket upgrades are rejected with 403 when their `Origin`
 * header is not one of the server's own loopback origins or the Vite dev origin. Browsers
 * always send `Origin` on cross-origin POST, DELETE, and WebSocket requests, so this blocks
 * other pages in the user's browser from driving the API. Requests without an `Origin`
 * header come from non-browser clients (curl, tests) and are allowed.
 *
 * The allowed set is fixed from configuration, not derived from the `Host` header, so a
 * DNS-rebinding page cannot make its own origin look like the server's.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "../logging/logger.js";

export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

/** Error body for rejected requests. */
export const FORBIDDEN_ORIGIN_ERROR = "The ghost does not answer calls from strange origins.";

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * The configured server origin, its loopback aliases, the Vite dev origins, and any configured
 * public origins (for example the service's https://….onrender.com URL).
 */
export function allowedOrigins(host: string, port: number, publicOrigins: readonly string[] = []): Set<string> {
  const origins = new Set<string>([...DEV_ORIGINS, ...publicOrigins]);
  for (const h of [host, "127.0.0.1", "localhost", "::1"]) {
    if (h === "0.0.0.0" || h === "::") continue;
    origins.add(`http://${hostForUrl(h)}:${port}`);
  }
  return origins;
}

/** True when the request must pass the origin check. */
export function isGuardedRequest(method: string, upgrade: string | undefined): boolean {
  return method === "POST" || method === "DELETE" || upgrade?.toLowerCase() === "websocket";
}

/** A missing Origin is allowed; a present one must match exactly. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin === undefined || allowed.has(origin);
}

/** Fastify `onRequest` hook enforcing the origin check. Rejections are logged without the body. */
export function createOriginGuard(allowed: ReadonlySet<string>, logger: Logger) {
  return async function originGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isGuardedRequest(request.method, request.headers.upgrade)) return;
    const origin = request.headers.origin;
    if (isAllowedOrigin(origin, allowed)) return;
    logger.warn({ method: request.method, url: request.url, origin }, "rejected request from a foreign origin");
    await reply.code(403).send({ error: FORBIDDEN_ORIGIN_ERROR });
  };
}
