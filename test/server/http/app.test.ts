import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type HauntedApp } from "../../../src/server/app.js";
import { chatFailureMessage } from "../../../src/server/agent/replyTemplates.js";
import { loadConfig } from "../../../src/server/config/loadConfig.js";
import { FORBIDDEN_ORIGIN_ERROR } from "../../../src/server/http/originGuard.js";
import { CHAT_RATE_LIMITED_ERROR, DAILY_LIMIT_ERROR } from "../../../src/server/http/routes.js";
import type { LlmProvider } from "../../../src/server/llm/LlmClient.js";
import { createLogger } from "../../../src/server/logging/logger.js";
import type { TtsProvider } from "../../../src/server/tts/TtsClient.js";
import type { ConfirmProposalResponse, GhostReply, HauntingAlert, ServerEvent } from "../../../src/shared/types.js";

const KEY = "sk-or-v1-app-test-secret";
const ORIGIN = "http://127.0.0.1:3000";
const quiet = () => createLogger([KEY], new Writable({ write: (_c, _e, cb) => cb() }));

let current: HauntedApp | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(llm: LlmProvider["complete"], env: Record<string, string> = {}) {
  const config = loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY, HAUNTED_POLL_INTERVAL_MS: "1000", ...env }, undefined, {
    platform: "linux",
  });
  let ttsCalls = 0;
  const tts: TtsProvider = {
    synthesize: async () => {
      ttsCalls++;
      return { audio: Buffer.from("ID3-fake-mp3"), mimeType: "audio/mpeg" };
    },
  };
  current = await buildApp({ config, logger: quiet(), llmProvider: { complete: llm }, ttsProvider: tts });
  await current.app.ready();
  return { haunted: current, ttsCalls: () => ttsCalls };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const reply = (text: string) => JSON.stringify({ reply: text, mentionedContainer: null, proposal: null });

describe("Backend HTTP layer", () => {
  it("serves public config without secrets and state before the first snapshot", async () => {
    const { haunted } = await setup(async () => reply("unused"));
    const config = await haunted.app.inject({ method: "GET", url: "/api/config" });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ dataSource: "simulator", aiGateway: "openrouter" });
    expect(config.body).not.toContain(KEY);
    expect(config.body).not.toContain("openrouter.ai/api");

    const state = await haunted.app.inject({ method: "GET", url: "/api/state" });
    expect(state.json()).toEqual({ alerts: [], proposals: [] });
  });

  it("rejects POST, DELETE, and WebSocket upgrades from a foreign origin", async () => {
    const { haunted } = await setup(async () => reply("unused"));
    const headers = { origin: "http://evil.example" };
    const post = await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "hi", history: [] } });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toEqual({ error: FORBIDDEN_ORIGIN_ERROR });
    const del = await haunted.app.inject({ method: "DELETE", url: "/api/sim/incidents", headers });
    expect(del.statusCode).toBe(403);
    await expect(haunted.app.injectWS("/ws", { headers })).rejects.toThrow();
  });

  it("accepts requests from a configured public origin such as the Render URL", async () => {
    const { haunted } = await setup(async () => reply("unused"), {
      RENDER_EXTERNAL_URL: "https://haunted-homelab.onrender.com",
    });
    const ok = await haunted.app.inject({
      method: "DELETE",
      url: "/api/sim/incidents",
      headers: { origin: "https://haunted-homelab.onrender.com" },
    });
    expect(ok.statusCode).toBe(200);
    const ws = await haunted.app.injectWS("/ws", { headers: { origin: "https://haunted-homelab.onrender.com" } });
    ws.terminate();
    const foreign = await haunted.app.inject({
      method: "DELETE",
      url: "/api/sim/incidents",
      headers: { origin: "https://evil.onrender.com" },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("answers chat, maps provider failures to 502, and speaks stored replies once per id", async () => {
    let fail = false;
    const { haunted, ttsCalls } = await setup(async () => {
      if (fail) throw new Error("upstream exploded");
      return reply("The plex vessel hums softly in the dark.");
    });
    const headers = { origin: ORIGIN };

    const ok = await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "How is plex?", history: [] } });
    expect(ok.statusCode).toBe(200);
    const ghost = ok.json<GhostReply>();
    expect(ghost.text).toBe("The plex vessel hums softly in the dark.");

    const bad = await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "", history: [] } });
    expect(bad.statusCode).toBe(400);

    fail = true;
    const failed = await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "Status?", history: [] } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: chatFailureMessage() });
    expect(failed.body).not.toContain("upstream exploded");

    for (let i = 0; i < 2; i++) {
      const audio = await haunted.app.inject({ method: "GET", url: `/api/speech/${ghost.id}` });
      expect(audio.statusCode).toBe(200);
      expect(audio.headers["content-type"]).toBe("audio/mpeg");
      expect(audio.rawPayload.toString()).toBe("ID3-fake-mp3");
    }
    expect(ttsCalls()).toBe(1);
    expect((await haunted.app.inject({ method: "GET", url: "/api/speech/nope" })).statusCode).toBe(404);
  });

  it("rate limits chat per visitor with a persona 429 and Retry-After", async () => {
    const { haunted } = await setup(async () => reply("The plex vessel hums."));
    const ask = (ip: string) =>
      haunted.app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { origin: ORIGIN, "x-forwarded-for": `${ip}, 10.0.0.1` },
        payload: { question: "Status?", history: [] },
      });
    for (let i = 0; i < 15; i++) expect((await ask("203.0.113.7")).statusCode).toBe(200);
    const limited = await ask("203.0.113.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: CHAT_RATE_LIMITED_ERROR });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await ask("198.51.100.4")).statusCode).toBe(200);
  });

  it("refuses chat once the daily LLM budget is used, while alerts fall back to templates", async () => {
    const { haunted } = await setup(async () => reply("The machine hums."), { HAUNTED_DAILY_LLM_CALLS: "1" });
    const headers = { origin: ORIGIN };
    const payload = { question: "Status?", history: [] };
    expect((await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload })).statusCode).toBe(200);
    const refused = await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: DAILY_LIMIT_ERROR });

    haunted.start();
    await waitFor(() => haunted.monitor.latestSnapshot());
    await haunted.app.inject({ method: "POST", url: "/api/sim/incidents", headers, payload: { type: "container_crash", container: "plex" } });
    const alert = await waitFor<HauntingAlert>(() => haunted.alerts.activeAlerts().find((a) => a.ruleId === "container_exited"), 3000);
    expect(alert.message).toBe("The spirit of plex has left its vessel. It now lies exited in the dark.");
  });

  it("limits new speech clips per day but replays cached clips for free", async () => {
    const { haunted, ttsCalls } = await setup(async () => reply("The machine hums."), { HAUNTED_DAILY_SPEECH_CLIPS: "1" });
    const headers = { origin: ORIGIN };
    const first = (await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "A?", history: [] } })).json<GhostReply>();
    const second = (await haunted.app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "B?", history: [] } })).json<GhostReply>();

    expect((await haunted.app.inject({ method: "GET", url: `/api/speech/${first.id}` })).statusCode).toBe(200);
    expect((await haunted.app.inject({ method: "GET", url: `/api/speech/${first.id}` })).statusCode).toBe(200);
    const limited = await haunted.app.inject({ method: "GET", url: `/api/speech/${second.id}` });
    expect(limited.statusCode).toBe(429);
    expect(ttsCalls()).toBe(1);
  });

  it("validates incident staging and returns 404 for incident routes in Docker mode", async () => {
    const { haunted } = await setup(async () => reply("unused"));
    const headers = { origin: ORIGIN };
    const noTarget = await haunted.app.inject({ method: "POST", url: "/api/sim/incidents", headers, payload: { type: "container_crash" } });
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json().error).toContain("container_crash");
    const unknown = await haunted.app.inject({
      method: "POST",
      url: "/api/sim/incidents",
      headers,
      payload: { type: "memory_leak", container: "plexx" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain("plexx");
    const staged = await haunted.app.inject({ method: "POST", url: "/api/sim/incidents", headers, payload: { type: "disk_full" } });
    expect(staged.json()).toEqual([expect.objectContaining({ type: "disk_full" })]);
    const cleared = await haunted.app.inject({ method: "DELETE", url: "/api/sim/incidents", headers });
    expect(cleared.json()).toEqual([]);
  });

  it("raises an alert for a crash, restarts through the proposal, and resolves the alert", async () => {
    const { haunted } = await setup(async () => "not an acceptable alert sentence");
    const headers = { origin: ORIGIN };
    const ws = await haunted.app.injectWS("/ws", { headers });
    const received: ServerEvent[] = [];
    ws.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()) as ServerEvent));

    haunted.start();
    await waitFor(() => haunted.monitor.latestSnapshot());
    await haunted.app.inject({ method: "POST", url: "/api/sim/incidents", headers, payload: { type: "container_crash", container: "plex" } });

    const alert = await waitFor<HauntingAlert>(() => haunted.alerts.activeAlerts().find((a) => a.ruleId === "container_exited"), 3000);
    expect(alert.message).toBe("The spirit of plex has left its vessel. It now lies exited in the dark.");
    expect(alert.proposalId).toBeDefined();

    const confirm = await haunted.app.inject({ method: "POST", url: `/api/proposals/${alert.proposalId}/confirm`, headers });
    expect(confirm.statusCode).toBe(200);
    const body = confirm.json<ConfirmProposalResponse>();
    expect(body.proposal.status).toBe("confirmed");
    expect(body.reply.text).toContain("succeeded");

    const again = await haunted.app.inject({ method: "POST", url: `/api/proposals/${alert.proposalId}/confirm`, headers });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "already_confirmed" });

    await waitFor(() => (haunted.alerts.activeAlerts().some((a) => a.ruleId === "container_exited") ? undefined : true), 3000);
    await waitFor(() => (received.some((e) => e.type === "alert.resolved") ? true : undefined));
    const types = received.map((e) => e.type);
    expect(types).toContain("snapshot");
    expect(types.indexOf("alert.raised")).toBeLessThan(types.indexOf("alert.resolved"));
    expect(types).toContain("proposal.updated");
    expect(types).toContain("chat.message");
    expect(JSON.stringify(received)).not.toContain(KEY);
    ws.terminate();
  }, 15_000);
});
