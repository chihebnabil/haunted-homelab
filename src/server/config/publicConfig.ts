import type { PublicConfig } from "../../shared/types.js";
import type { Config } from "./schema.js";

/**
 * Whitelisted projection sent to the browser. Each field is copied explicitly,
 * so the API key, the OpenRouter base URL, and the Docker endpoint never appear.
 */
export function toPublicConfig(c: Config): PublicConfig {
  return {
    dataSource: c.dataSource,
    aiGateway: "openrouter",
    llmModel: c.llm.model,
    ttsModel: c.tts.model,
    pollIntervalMs: c.monitor.pollIntervalMs,
    thresholds: {
      cpuPercent: c.thresholds.cpuPercent,
      cpuDurationSeconds: c.thresholds.cpuDurationSeconds,
      memoryPercent: c.thresholds.memoryPercent,
      diskPercent: c.thresholds.diskPercent,
    },
  };
}
