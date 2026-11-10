import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, type FetchLike } from "../../../src/web/api/rest.js";
import type { ActionProposalDTO, GhostReply } from "../../../src/shared/types.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const proposal: ActionProposalDTO = {
  id: "p1",
  action: "restart",
  container: "plex",
  reason: "plex exited",
  createdAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2024-01-01T00:05:00.000Z",
  status: "expired",
};

const reply: GhostReply = { id: "r1", text: "The spirits are calm.", createdAt: "2024-01-01T00:00:00.000Z" };

afterEach(() => {
  vi.useRealTimers();
});

describe("createApiClient", () => {
  it("GETs config and state from the same origin by default", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { alerts: [], proposals: [] }));
    const api = createApiClient({ fetch });
    await expect(api.getState()).resolves.toEqual({ alerts: [], proposals: [] });
    await api.getConfig();
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["GET", "/api/state"],
      ["GET", "/api/config"],
    ]);
  });

  it("POSTs chat as JSON and returns the ghost reply", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, reply));
    const api = createApiClient({ fetch, baseUrl: "http://127.0.0.1:3000" });
    const req = { question: "Is plex okay?", history: [{ role: "user" as const, text: "hi" }] };
    await expect(api.chat(req)).resolves.toEqual(reply);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/api/chat");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(req);
    expect((calls[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("rejects a 502 chat response with the persona error text", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(502, { error: "The ghost lost its voice in the void." }));
    const api = createApiClient({ fetch });
    const err = await api.chat({ question: "hi", history: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.kind).toBe("http");
    expect(apiErr.status).toBe(502);
    expect(apiErr.errorText).toBe("The ghost lost its voice in the void.");
  });

  it("aborts chat after the client timeout and rejects with kind timeout", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const fetch: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        seenSignal = init?.signal ?? undefined;
        seenSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const api = createApiClient({ fetch });
    const pending = api.chat({ question: "hi", history: [] }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(seenSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = (await pending) as ApiError;
    expect(seenSignal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("timeout");
  });

  it("confirm and cancel POST without a JSON content type or body", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, { proposal, reply }));
    const api = createApiClient({ fetch });
    await api.confirmProposal("p1");
    await api.cancelProposal("p/2");
    expect(calls.map((c) => c.url)).toEqual(["/api/proposals/p1/confirm", "/api/proposals/p%2F2/cancel"]);
    for (const c of calls) {
      expect(c.init?.method).toBe("POST");
      expect(c.init?.body).toBeUndefined();
      expect((c.init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    }
  });

  it("rejects a 409 confirm with the reason and proposal", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(409, { proposal, reason: "expired" }));
    const api = createApiClient({ fetch });
    const err = (await api.confirmProposal("p1").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.reason).toBe("expired");
    expect(err.proposal).toEqual(proposal);
  });

  it("calls the incident endpoints with the right methods", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, []));
    const api = createApiClient({ fetch });
    await api.listIncidents();
    await api.stageIncident({ type: "container_crash", container: "plex" });
    await api.clearIncidents();
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["GET", "/api/sim/incidents"],
      ["POST", "/api/sim/incidents"],
      ["DELETE", "/api/sim/incidents"],
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ type: "container_crash", container: "plex" });
    expect(calls[2]?.init?.body).toBeUndefined();
  });

  it("rejects a 400 incident response with the persona error", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(400, { error: "No container named ghost haunts here." }));
    const api = createApiClient({ fetch });
    const err = (await api.stageIncident({ type: "memory_leak", container: "ghost" }).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.errorText).toBe("No container named ghost haunts here.");
  });

  it("fetches speech with the caller signal and returns an object URL of the blob", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33]);
    const { fetch, calls } = recordingFetch(
      () => new Response(audio, { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    );
    const blobs: Blob[] = [];
    const api = createApiClient({
      fetch,
      createObjectURL: (b) => {
        blobs.push(b);
        return "blob:ghost-1";
      },
    });
    const controller = new AbortController();
    await expect(api.fetchSpeech("m 1", controller.signal)).resolves.toBe("blob:ghost-1");
    expect(calls[0]?.url).toBe("/api/speech/m%201");
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(blobs[0]?.size).toBe(3);
    expect(blobs[0]?.type).toBe("audio/mpeg");
  });

  it("rejects speech with kind aborted when the caller aborts", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const api = createApiClient({ fetch, createObjectURL: () => "unused" });
    const controller = new AbortController();
    const pending = api.fetchSpeech("m1", controller.signal).catch((e: unknown) => e);
    controller.abort();
    const err = (await pending) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("aborted");
  });

  it("rejects speech 504 with status and no audio", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(504, { error: "The voice was lost in the static." }));
    const createObjectURL = vi.fn(() => "unused");
    const api = createApiClient({ fetch, createObjectURL });
    const err = (await api.fetchSpeech("m1").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(504);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("wraps network failures as kind network", async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError("Failed to fetch"));
    const api = createApiClient({ fetch });
    const err = (await api.getState().catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("network");
    expect(err.status).toBe(0);
  });
});
