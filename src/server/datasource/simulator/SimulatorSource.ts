import type {
  Clock,
  ContainerInfo,
  HostMetrics,
  IncidentType,
  LogLine,
  StagedIncident,
} from "../../../shared/types.js";
import type { DataSource } from "../types.js";
import {
  clearIncidents,
  initialState,
  observe,
  readLogsFromState,
  restartContainer,
  type SimState,
  stageIncident,
  stopContainer,
} from "./state.js";

/** Async DataSource adapter around the simulator's pure state transitions. */
export class SimulatorSource implements DataSource {
  readonly kind = "simulator" as const;

  private state: SimState;

  constructor(seed: number, private readonly clock: Clock) {
    this.state = initialState(seed);
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const observed = observe(this.state, this.clock.now());
    this.state = observed.state;
    return observed.containers;
  }

  async readLogs(name: string, maxLines: number): Promise<LogLine[]> {
    const result = readLogsFromState(this.state, name, maxLines, this.clock.now());
    this.state = result.state;
    return result.lines;
  }

  async readHostMetrics(): Promise<HostMetrics> {
    const observed = observe(this.state, this.clock.now());
    this.state = observed.state;
    return observed.host;
  }

  async restart(name: string): Promise<void> {
    this.state = restartContainer(this.state, name, this.clock.now());
  }

  async stop(name: string): Promise<void> {
    this.state = stopContainer(this.state, name, this.clock.now());
  }

  listIncidents(): StagedIncident[] {
    return this.state.incidents.map((incident) => ({ ...incident }));
  }

  stage(type: IncidentType, target?: string): StagedIncident[] {
    this.state = stageIncident(this.state, type, target, this.clock.now());
    return this.listIncidents();
  }

  clearAll(): StagedIncident[] {
    this.state = clearIncidents(this.state, this.clock.now());
    return this.listIncidents();
  }
}
