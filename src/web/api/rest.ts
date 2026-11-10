/**
 * Typed REST client for the Backend HTTP API.
 * `fetch` and `URL.createObjectURL` are injectable so tests can run without a server.
 */
import type {
  CancelProposalResponse,
  ChatRequest,
  ChatResponse,
  ConfigResponse,
  ConfirmProposalResponse,
  ConfirmRejectionReason,
  ActionProposalDTO,
  IncidentsResponse,
  StageIncidentRequest,
  StateResponse,
} from "../../shared/types.js";

/** Client-side abort for chat requests. The server deadline is 30 s (Requirement 6.7). */
export const CHAT_TIMEOUT_MS = 35_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiErrorKind = "http" | "timeout" | "aborted" | "network";

/**
 * Rejection value for every failed API call.
 * - `http`: non-2xx response; `status` and parsed `body` are set.
 * - `timeout`: the client-side timeout fired (chat only).
 * - `aborted`: the caller's AbortSignal fired.
 * - `network`: the request never produced a response.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }

  /** Persona `error` text from an `ErrorResponse` body, when present. */
  get errorText(): string | undefined {
    const b = this.body;
    return isRecord(b) && typeof b.error === "string" ? b.error : undefined;
  }

  /** 409 rejection reason from a `ProposalRejectedResponse` body, when present. */
  get reason(): ConfirmRejectionReason | undefined {
    const b = this.body;
    return isRecord(b) && typeof b.reason === "string" ? (b.reason as ConfirmRejectionReason) : undefined;
  }

  /** Proposal from a `ProposalRejectedResponse` body, when present. */
  get proposal(): ActionProposalDTO | undefined {
    const b = this.body;
    return isRecord(b) && isRecord(b.proposal) ? (b.proposal as unknown as ActionProposalDTO) : undefined;
  }
}

export interface ApiClientOptions {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Prefix for every path. Defaults to "" (same origin). */
  baseUrl?: string;
  /** Defaults to `URL.createObjectURL`. */
  createObjectURL?: (blob: Blob) => string;
  /** Overrides CHAT_TIMEOUT_MS (tests). */
  chatTimeoutMs?: number;
}

export interface ApiClient {
  getConfig(): Promise<ConfigResponse>;
  getState(): Promise<StateResponse>;
  /** Rejects with `ApiError` kind `timeout` after 35 s, or kind `http` (502/504) with persona text. */
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /** Rejects with `ApiError` status 409 carrying `reason` and `proposal` when the confirm is rejected. */
  confirmProposal(id: string): Promise<ConfirmProposalResponse>;
  cancelProposal(id: string): Promise<CancelProposalResponse>;
  listIncidents(): Promise<IncidentsResponse>;
  stageIncident(req: StageIncidentRequest): Promise<IncidentsResponse>;
  clearIncidents(): Promise<IncidentsResponse>;
  /** Fetches mp3 audio for a stored message and returns an object URL for the blob. */
  fetchSpeech(messageId: string, signal?: AbortSignal): Promise<string>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = opts.baseUrl ?? "";
  const createObjectURL = opts.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const chatTimeoutMs = opts.chatTimeoutMs ?? CHAT_TIMEOUT_MS;

  async function send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timedOut: () => boolean = () => false,
  ): Promise<Response> {
    const init: RequestInit = { method, headers: { Accept: "application/json" } };
    // Only send a JSON content type with a body: Fastify rejects an empty JSON body.
    if (body !== undefined) {
      init.headers = { Accept: "application/json", "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    if (signal) init.signal = signal;

    let res: Response;
    try {
      res = await doFetch(baseUrl + path, init);
    } catch (err) {
      if (timedOut()) throw new ApiError("timeout", 0, undefined, `${method} ${path} timed out`);
      if (signal?.aborted) throw new ApiError("aborted", 0, undefined, `${method} ${path} was aborted`);
      throw new ApiError("network", 0, undefined, `${method} ${path} failed: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      const parsed = await readBody(res);
      throw new ApiError("http", res.status, parsed, `${method} ${path} failed with status ${res.status}`);
    }
    return res;
  }

  async function json<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body, undefined);
    return (await res.json()) as T;
  }

  return {
    getConfig: () => json<ConfigResponse>("GET", "/api/config"),
    getState: () => json<StateResponse>("GET", "/api/state"),

    async chat(req, signal) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, chatTimeoutMs);
      const onCallerAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener("abort", onCallerAbort);
      try {
        const res = await send("POST", "/api/chat", req, controller.signal, () => timedOut);
        return (await res.json()) as ChatResponse;
      } catch (err) {
        if (timedOut && !(err instanceof ApiError && err.kind === "http")) {
          throw new ApiError("timeout", 0, undefined, "POST /api/chat timed out");
        }
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCallerAbort);
      }
    },

    confirmProposal: (id) =>
      json<ConfirmProposalResponse>("POST", `/api/proposals/${encodeURIComponent(id)}/confirm`),
    cancelProposal: (id) =>
      json<CancelProposalResponse>("POST", `/api/proposals/${encodeURIComponent(id)}/cancel`),

    listIncidents: () => json<IncidentsResponse>("GET", "/api/sim/incidents"),
    stageIncident: (req) => json<IncidentsResponse>("POST", "/api/sim/incidents", req),
    clearIncidents: () => json<IncidentsResponse>("DELETE", "/api/sim/incidents"),

    async fetchSpeech(messageId, signal) {
      const res = await send("GET", `/api/speech/${encodeURIComponent(messageId)}`, undefined, signal);
      let blob: Blob;
      try {
        blob = await res.blob();
      } catch (err) {
        if (signal?.aborted) throw new ApiError("aborted", 0, undefined, "speech download was aborted");
        throw new ApiError("network", 0, undefined, `speech download failed: ${errorMessage(err)}`);
      }
      return createObjectURL(blob);
    },
  };
}

/** Default client for the app: same origin, global fetch. */
export const api: ApiClient = createApiClient();

async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
