/**
 * Backend entry point (Requirements 1.2, 1.3, 4.1, 10.3, 12.1, 12.3).
 * Reads the environment and the optional JSON file at HAUNTED_CONFIG, builds the Backend with
 * the OpenRouter providers, and listens on the configured host and port.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/loadConfig.js";
import { ConfigError, type Config } from "./config/schema.js";
import { OpenRouterLlm } from "./llm/openrouter.js";
import { createLogger } from "./logging/logger.js";
import { OpenRouterTts } from "./tts/openrouterTts.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readConfigFile(path: string | undefined): unknown {
  if (path === undefined || path.trim() === "") return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail(`Cannot read config file at HAUNTED_CONFIG=${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    fail(`Config file at HAUNTED_CONFIG=${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveConfig(): Config {
  try {
    return loadConfig(process.env, readConfigFile(process.env.HAUNTED_CONFIG));
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const logger = createLogger([config.openrouter.apiKey]);
  const { apiKey, baseUrl } = config.openrouter;

  let haunted;
  try {
    haunted = await buildApp({
      config,
      logger,
      llmProvider: new OpenRouterLlm({ apiKey, baseUrl, model: config.llm.model }),
      ttsProvider: new OpenRouterTts({ apiKey, baseUrl }),
      // Built layout: dist/server/main.js serves dist/web. In development Vite serves the UI.
      webRoot: fileURLToPath(new URL("../web", import.meta.url)),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  await haunted.app.listen({ host: config.server.host, port: config.server.port });
  haunted.start();
  logger.info(
    {
      host: config.server.host,
      port: config.server.port,
      allowedOrigins: config.server.allowedOrigins,
      dataSource: config.dataSource,
      llmModel: config.llm.model,
    },
    "the ghost has entered the machine",
  );

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "the ghost departs");
    haunted.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
