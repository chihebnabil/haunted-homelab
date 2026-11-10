/**
 * Builds the Backend from a resolved Config and injected AI providers. `main.ts` passes the
 * OpenRouter providers; tests pass mocks. Nothing here reads process.env or the filesystem
 * except the optional static web root.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Clock } from "../shared/types.js";
import { ProposalStore } from "./actions/ProposalStore.js";
import { Agent } from "./agent/Agent.js";
import { AlertService } from "./alerts/AlertService.js";
import { toPublicConfig } from "./config/publicConfig.js";
import type { Config } from "./config/schema.js";
import { createDataSource } from "./datasource/factory.js";
import { SimulatorSource } from "./datasource/simulator/SimulatorSource.js";
import type { DataSource } from "./datasource/types.js";
import { allowedOrigins, createOriginGuard } from "./http/originGuard.js";
import { registerRoutes } from "./http/routes.js";
import { WebSocketHub } from "./http/ws.js";
import { LlmClient, type LlmProvider } from "./llm/LlmClient.js";
import type { Logger } from "./logging/logger.js";
import { MessageStore } from "./messages/MessageStore.js";
import { Monitor } from "./monitor/Monitor.js";
import { TtsClient, type TtsProvider } from "./tts/TtsClient.js";

export interface BuildAppOptions {
  config: Config;
  llmProvider: LlmProvider;
  ttsProvider: TtsProvider;
  logger: Logger;
  clock?: Clock;
  /** Overrides the configured data source (tests). */
  dataSource?: DataSource;
  /** Directory with the built Web_App. Served only when it contains index.html. */
  webRoot?: string;
}

export interface HauntedApp {
  app: FastifyInstance;
  monitor: Monitor;
  hub: WebSocketHub;
  alerts: AlertService;
  proposals: ProposalStore;
  messages: MessageStore;
  dataSource: DataSource;
  /** Starts the Monitor. Call after `app.listen`. */
  start(): void;
  /** Stops the Monitor, closes WebSocket clients, and closes the server. */
  close(): Promise<void>;
}

export async function buildApp(options: BuildAppOptions): Promise<HauntedApp> {
  const { config, logger } = options;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const dataSource = options.dataSource ?? createDataSource(config, clock, logger);

  const llm = new LlmClient(options.llmProvider, logger);
  const tts = new TtsClient(options.ttsProvider, config.tts, logger);
  const messages = new MessageStore();
  const proposals = new ProposalStore({ ds: dataSource, clock });
  const agent = new Agent({ ds: dataSource, llm, proposals, messages, clock, logger });
  const hub = new WebSocketHub(logger);
  const alerts = new AlertService({ agent, proposals, hub, messages, clock, logger });

  const monitor = new Monitor({
    ds: dataSource,
    clock,
    thresholds: config.thresholds,
    pollIntervalMs: config.monitor.pollIntervalMs,
    logger,
    onSnapshot: (snapshot) => hub.broadcast({ type: "snapshot", snapshot }),
    onEvents: (raised, resolved) => alerts.handle(raised, resolved),
  });

  // Fastify's own logger stays off: every log line goes through the scrubbing logger.
  const app = Fastify({ logger: false });
  const origins = allowedOrigins(config.server.host, config.server.port, config.server.allowedOrigins);
  app.addHook("onRequest", createOriginGuard(origins, logger));
  await app.register(fastifyWebsocket);
  hub.register(app);

  const routeDeps = {
    publicConfig: toPublicConfig(config),
    agent,
    proposals,
    alerts,
    messages,
    tts,
    hub,
    latestSnapshot: () => monitor.latestSnapshot(),
    clock,
    logger,
  };
  registerRoutes(
    app,
    dataSource instanceof SimulatorSource ? { ...routeDeps, simulator: dataSource } : routeDeps,
  );

  if (options.webRoot !== undefined && existsSync(join(options.webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webRoot });
  }

  return {
    app,
    monitor,
    hub,
    alerts,
    proposals,
    messages,
    dataSource,
    start: () => monitor.start(),
    async close() {
      monitor.stop();
      hub.closeAll();
      await app.close();
    },
  };
}
