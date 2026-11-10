/**
 * HTTP routes (Requirements 3.3, 5.3, 6.3, 6.7, 9.1, 9.2, 9.5, 11.4-11.9, 12.4, 13.2).
 * Every response body is built from shared DTO types that carry no secrets.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  INCIDENT_TYPES,
  type CancelProposalResponse,
  type ChatResponse,
  type ConfigResponse,
  type ConfirmProposalResponse,
  type ErrorResponse,
  type IncidentsResponse,
  type ProposalRejectedResponse,
  type PublicConfig,
  type Snapshot,
  type StateResponse,
} from "../../shared/types.js";
import type { ProposalStore } from "../actions/ProposalStore.js";
import type { Agent } from "../agent/Agent.js";
import { chatFailureMessage } from "../agent/replyTemplates.js";
import type { AlertService } from "../alerts/AlertService.js";
import { IncidentTargetRequiredError } from "../datasource/simulator/state.js";
import type { SimulatorSource } from "../datasource/simulator/SimulatorSource.js";
import { ContainerNotFoundError, DataSourceUnavailableError } from "../datasource/types.js";
import { LlmProviderError, LlmTimeoutError } from "../llm/LlmClient.js";
import type { Logger } from "../logging/logger.js";
import type { MessageStore } from "../messages/MessageStore.js";
import { TtsProviderError, TtsTimeoutError, type TtsClient } from "../tts/TtsClient.js";
import type { Clock } from "../../shared/types.js";
import type { WsHub } from "./hub.js";

/** Server-side deadline for one chat answer (Requirement 6.7). */
export const CHAT_DEADLINE_MS = 30_000;

export const GENERIC_ERROR = "The machine shuddered and the ghost lost its words. Try again.";
export const BAD_REQUEST_ERROR = "The ghost could not read that request.";
export const UNKNOWN_MESSAGE_ERROR = "That message has faded from the ghost's memory.";
export const SPEECH_FAILED_ERROR = "The voice was lost in the static.";
export const SIMULATOR_ONLY_ERROR = "Incidents can only be staged when the simulator haunts this machine.";

export interface RouteDeps {
  publicConfig: PublicConfig;
  agent: Pick<Agent, "answer" | "reportActionResult">;
  proposals: ProposalStore;
  alerts: Pick<AlertService, "recentAlerts">;
  messages: MessageStore;
  tts: Pick<TtsClient, "speak">;
  hub: WsHub;
  latestSnapshot: () => Snapshot | undefined;
  /** Present only in simulator mode. */
  simulator?: SimulatorSource;
  clock: Clock;
  logger: Logger;
}

const ChatBody = z.object({
  question: z
    .string()
    .min(1)
    .max(2000)
    .refine((q) => q.trim().length > 0),
  history: z
    .array(z.object({ role: z.enum(["user", "ghost"]), text: z.string().max(20_000) }))
    .max(10)
    .default([]),
});

const StageBody = z.object({
  type: z.enum(INCIDENT_TYPES),
  container: z.string().max(200).optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(200) });
const MessageParams = z.object({ messageId: z.string().min(1).max(200) });

function sendError(reply: FastifyReply, status: number, error: string): FastifyReply {
  const body: ErrorResponse = { error };
  return reply.code(status).send(body);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { agent, proposals, messages, tts, hub, logger } = deps;

  app.setErrorHandler((err, request, reply) => {
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) logger.error({ err, method: request.method, url: request.url }, "unhandled route error");
    void sendError(reply, status, status === 500 ? GENERIC_ERROR : BAD_REQUEST_ERROR);
  });

  app.get("/api/config", async () => {
    const body: ConfigResponse = deps.publicConfig;
    return body;
  });

  app.get("/api/state", async () => {
    const snapshot = deps.latestSnapshot();
    const body: StateResponse = { alerts: deps.alerts.recentAlerts(), proposals: proposals.list() };
    if (snapshot !== undefined) body.snapshot = snapshot;
    return body;
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = ChatBody.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Questions must be 1 to 2000 characters with at most 10 history turns.");
    try {
      const { question, history } = parsed.data;
      const body: ChatResponse = await agent.answer(question, history, deps.clock.now() + CHAT_DEADLINE_MS);
      return body;
    } catch (err) {
      if (err instanceof LlmTimeoutError) return sendError(reply, 504, chatFailureMessage());
      if (err instanceof LlmProviderError || err instanceof DataSourceUnavailableError) {
        logger.warn({ err }, "chat answer failed");
        return sendError(reply, 502, chatFailureMessage());
      }
      logger.error({ err }, "chat answer failed unexpectedly");
      return sendError(reply, 500, chatFailureMessage());
    }
  });

  app.post("/api/proposals/:id/confirm", async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, BAD_REQUEST_ERROR);

    const outcome = await proposals.confirm(params.data.id);
    if (outcome.kind === "rejected") {
      if (outcome.dto !== undefined && outcome.reason === "expired") {
        hub.broadcast({ type: "proposal.updated", proposal: outcome.dto });
      }
      const body: ProposalRejectedResponse = { reason: outcome.reason };
      if (outcome.dto !== undefined) body.proposal = outcome.dto;
      return reply.code(409).send(body);
    }

    const replyMessage = await agent.reportActionResult(outcome.proposal, outcome.result);
    hub.broadcast({ type: "proposal.updated", proposal: outcome.dto });
    hub.broadcast({ type: "chat.message", reply: replyMessage });
    const body: ConfirmProposalResponse = { proposal: outcome.dto, reply: replyMessage };
    return body;
  });

  app.post("/api/proposals/:id/cancel", async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, BAD_REQUEST_ERROR);

    const outcome = proposals.cancel(params.data.id);
    if (!outcome.ok) {
      const body: ProposalRejectedResponse = { reason: outcome.reason };
      if (outcome.dto !== undefined) body.proposal = outcome.dto;
      return reply.code(409).send(body);
    }
    hub.broadcast({ type: "proposal.updated", proposal: outcome.dto });
    const body: CancelProposalResponse = { proposal: outcome.dto };
    return body;
  });

  app.get("/api/speech/:messageId", async (request, reply) => {
    const params = MessageParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, BAD_REQUEST_ERROR);
    const id = params.data.messageId;

    const text = messages.getText(id);
    if (text === undefined) return sendError(reply, 404, UNKNOWN_MESSAGE_ERROR);

    let audio = messages.getAudio(id);
    if (audio === undefined) {
      try {
        audio = await tts.speak(text);
      } catch (err) {
        if (err instanceof TtsTimeoutError) return sendError(reply, 504, SPEECH_FAILED_ERROR);
        if (err instanceof TtsProviderError) return sendError(reply, 502, SPEECH_FAILED_ERROR);
        logger.error({ err }, "speech failed unexpectedly");
        return sendError(reply, 500, SPEECH_FAILED_ERROR);
      }
      messages.setAudio(id, audio);
    }
    return reply.header("Content-Type", audio.mimeType).header("Cache-Control", "private, max-age=3600").send(audio.audio);
  });

  registerIncidentRoutes(app, deps.simulator);
}

function registerIncidentRoutes(app: FastifyInstance, simulator: SimulatorSource | undefined): void {
  if (simulator === undefined) {
    const notSimulator = async (_request: unknown, reply: FastifyReply) => sendError(reply, 404, SIMULATOR_ONLY_ERROR);
    app.get("/api/sim/incidents", notSimulator);
    app.post("/api/sim/incidents", notSimulator);
    app.delete("/api/sim/incidents", notSimulator);
    return;
  }

  app.get("/api/sim/incidents", async () => {
    const body: IncidentsResponse = simulator.listIncidents();
    return body;
  });

  app.post("/api/sim/incidents", async (request, reply) => {
    const parsed = StageBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, `Incident type must be one of: ${INCIDENT_TYPES.join(", ")}.`);
    }
    try {
      const body: IncidentsResponse = simulator.stage(parsed.data.type, parsed.data.container);
      return body;
    } catch (err) {
      if (err instanceof IncidentTargetRequiredError) return sendError(reply, 400, err.message);
      if (err instanceof ContainerNotFoundError) {
        return sendError(reply, 400, `Unknown container "${err.containerName}".`);
      }
      throw err;
    }
  });

  app.delete("/api/sim/incidents", async () => {
    const body: IncidentsResponse = simulator.clearAll();
    return body;
  });
}
