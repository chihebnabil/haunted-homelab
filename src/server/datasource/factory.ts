import type { Clock } from "../../shared/types.js";
import type { Config } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import { SimulatorSource } from "./simulator/SimulatorSource.js";
import type { DataSource } from "./types.js";

/** Builds the configured data source. Docker support is intentionally unavailable in the MVP. */
export function createDataSource(config: Config, clock: Clock, _logger: Logger): DataSource {
  if (config.dataSource === "simulator") {
    return new SimulatorSource(config.simulator.seed, clock);
  }

  throw new Error("Docker data source is not built yet. Set HAUNTED_DATA_SOURCE=simulator.");
}
