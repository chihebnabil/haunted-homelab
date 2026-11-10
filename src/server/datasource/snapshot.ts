import type { Clock, Snapshot } from "../../shared/types.js";
import type { DataSource } from "./types.js";

/**
 * Reads all Containers and the Host_Metrics in parallel and stamps `readAt`
 * from the clock once both reads have finished. Rejects with the first error
 * from either read.
 */
export async function readSnapshot(ds: DataSource, clock: Clock): Promise<Snapshot> {
  const [containers, host] = await Promise.all([ds.listContainers(), ds.readHostMetrics()]);
  return {
    readAt: new Date(clock.now()).toISOString(),
    containers,
    host,
  };
}
