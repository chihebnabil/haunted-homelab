/**
 * The Data_Source interface (Requirement 1.1) and its error types.
 *
 * The Agent, Monitor, Status_Panel (through backend events), and Action_Executor
 * read homelab data and perform Actions only through this interface (Requirement 1.4).
 */

import type { ContainerInfo, DataSourceName, HostMetrics, LogLine } from "../../shared/types.js";

export interface DataSource {
  readonly kind: DataSourceName;
  /** Every Container, including stopped ones. */
  listContainers(): Promise<ContainerInfo[]>;
  /** The most recent log lines of the named Container, at most `maxLines`, oldest first. */
  readLogs(name: string, maxLines: number): Promise<LogLine[]>;
  readHostMetrics(): Promise<HostMetrics>;
  restart(name: string): Promise<void>;
  stop(name: string): Promise<void>;
}

/** The data source cannot be reached. The message names the configured endpoint (Requirement 2.5). */
export class DataSourceUnavailableError extends Error {
  override readonly name = "DataSourceUnavailableError";
  readonly endpoint: string;

  constructor(endpoint: string, cause?: unknown) {
    super(`Data source unavailable at ${endpoint}`, cause === undefined ? undefined : { cause });
    this.endpoint = endpoint;
  }
}

/** A request named a Container the data source does not report (Requirement 2.6). */
export class ContainerNotFoundError extends Error {
  override readonly name = "ContainerNotFoundError";
  readonly containerName: string;

  constructor(containerName: string) {
    super(`Container not found: ${containerName}`);
    this.containerName = containerName;
  }
}

/** A restart or stop failed. The message is the error text reported by the data source (Requirement 2.4). */
export class DataSourceActionError extends Error {
  override readonly name = "DataSourceActionError";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
