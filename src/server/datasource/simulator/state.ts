/**
 * Pure simulator state for the Simulator_Source.
 *
 * Default model (Requirement 3.1): an 8-core host with 32 GiB of memory, filesystems `/`
 * and `/mnt/media`, and five running service containers. All values are a pure function
 * of (seed, now) while nothing is staged or stopped.
 *
 * Logs (Requirement 3.2) are generated lazily: `observe` and `readLogsFromState` fill in
 * every line since the container's log cursor, using tick timestamps.
 *
 * Incidents (Requirements 3.4-3.11) are layered on top of the default model in
 * `computeView`. Memory leak growth happens only in `observe`, because each observe is
 * one read of the data source.
 *
 * Every function returns a new state and never mutates its input.
 */

import type {
  ContainerInfo,
  FilesystemUsage,
  HostMetrics,
  IncidentType,
  LogLine,
  StagedIncident,
} from "../../../shared/types.js";
import { ContainerNotFoundError } from "../types.js";
import { crashLines, defaultLinesBetween, restartLoopLine, restartLoopLinesBetween } from "./logs.js";
import { noise, TICK_MS, tickOf } from "./noise.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const HOST_CORES = 8;
export const HOST_MEMORY_TOTAL_BYTES = 32 * GIB;
/** Host memory used outside the containers. */
export const HOST_BASE_MEMORY_BYTES = 4 * GIB;
export const ROOT_FS_TOTAL_BYTES = 512 * 1000 ** 3;
export const MEDIA_FS_TOTAL_BYTES = 4 * 1000 ** 4;
export const ROOT_MOUNT = "/";
export const MEDIA_MOUNT = "/mnt/media";

/** Ring buffer size per container. */
export const LOG_BUFFER_LINES = 1000;
/** On a container's first observation, logs are backfilled for this long. */
export const LOG_BACKFILL_MS = 2 * 60_000;
/** Each tick adds at least one line, so catching up more ticks than the buffer holds is wasted work. */
const MAX_CATCHUP_MS = LOG_BUFFER_LINES * TICK_MS;

/** Disk usage drifts once per hour rather than every tick. */
const DISK_TICKS = 720;

/** The container added by a cpu_spike incident. */
export const GHOST_CONTAINER = "unknown-process-x13";
export const GHOST_MEMORY_BYTES = 64 * MIB;

export const HOST_INCIDENTS: readonly IncidentType[] = ["cpu_spike", "disk_full"];
export const CONTAINER_INCIDENTS: readonly IncidentType[] = ["memory_leak", "container_crash", "container_restart_loop"];

/** A memory leak grows by this much per read (4 % of host memory). */
export const LEAK_STEP_BYTES = Math.round(0.04 * HOST_MEMORY_TOTAL_BYTES);
/** A memory leak stops growing once host memory used reaches this fraction. */
export const LEAK_STOP_FRACTION = 0.95;
/** Leaked memory is clamped so host memory used never exceeds this fraction. */
export const LEAK_CAP_FRACTION = 0.99;
/** Root filesystem usage while disk_full is staged. */
export const DISK_FULL_FRACTION = 0.97;

interface Range {
  min: number;
  max: number;
}

const SPIKE_CPU: Range = { min: 96, max: 99 };

export interface ServiceProfile {
  name: string;
  /** CPU percent, within 2..25. */
  cpu: Range;
  /** Memory bytes, within 150 MiB..1.5 GiB. The maxima sum to about 3.3 GiB, under the 10 GiB budget. */
  memory: Range;
}

export const SERVICE_PROFILES: readonly ServiceProfile[] = [
  { name: "plex", cpu: { min: 8, max: 25 }, memory: { min: 800 * MIB, max: 1.5 * GIB } },
  { name: "pihole", cpu: { min: 2, max: 6 }, memory: { min: 150 * MIB, max: 260 * MIB } },
  { name: "homeassistant", cpu: { min: 4, max: 15 }, memory: { min: 450 * MIB, max: 900 * MIB } },
  { name: "nginx-proxy", cpu: { min: 2, max: 8 }, memory: { min: 150 * MIB, max: 320 * MIB } },
  { name: "uptime-kuma", cpu: { min: 2, max: 10 }, memory: { min: 160 * MIB, max: 400 * MIB } },
];

export const SIM_CONTAINER_NAMES: readonly string[] = SERVICE_PROFILES.map((p) => p.name);

export interface SimState {
  seed: number;
  /** Staged incidents in staging order. At most one container incident per target. */
  incidents: StagedIncident[];
  /** Containers stopped by request. */
  stopped: Set<string>;
  /** Ring buffer per container, at most LOG_BUFFER_LINES lines, oldest first. */
  logs: Map<string, LogLine[]>;
  /** Epoch ms up to which logs have been generated, per container. */
  logCursor: Map<string, number>;
}

/** The observed containers and host at one moment. */
export interface SimView {
  containers: ContainerInfo[];
  host: HostMetrics;
}

/** A container incident was staged without a target container. */
export class IncidentTargetRequiredError extends Error {
  override readonly name = "IncidentTargetRequiredError";
  readonly incidentType: IncidentType;

  constructor(incidentType: IncidentType) {
    super(`Incident "${incidentType}" requires a target container`);
    this.incidentType = incidentType;
  }
}

export function isContainerIncident(type: IncidentType): boolean {
  return CONTAINER_INCIDENTS.includes(type);
}

export function initialState(seed: number): SimState {
  return { seed, incidents: [], stopped: new Set(), logs: new Map(), logCursor: new Map() };
}

/**
 * A value in [min, max]: a steady per-seed base (70 %) plus per-tick jitter (30 %),
 * so values wander around a stable level instead of jumping across the whole range.
 */
function jittered(seed: number, key: string, tick: number, range: Range): number {
  const level = 0.7 * noise(seed, `${key}#base`, 0) + 0.3 * noise(seed, key, tick);
  return range.min + (range.max - range.min) * level;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The default reading of a service container at `tick`. */
export function defaultContainer(seed: number, profile: ServiceProfile, tick: number): ContainerInfo {
  return {
    name: profile.name,
    state: "running",
    cpuPercent: round1(jittered(seed, `cpu:${profile.name}`, tick, profile.cpu)),
    memoryBytes: Math.round(jittered(seed, `mem:${profile.name}`, tick, profile.memory)),
  };
}

/** The running ghost container of a cpu_spike incident: CPU 96-99 %, 64 MiB. */
export function ghostContainer(seed: number, tick: number): ContainerInfo {
  return {
    name: GHOST_CONTAINER,
    state: "running",
    cpuPercent: round1(jittered(seed, `cpu:${GHOST_CONTAINER}`, tick, SPIKE_CPU)),
    memoryBytes: GHOST_MEMORY_BYTES,
  };
}

/** A container that is not running reports zero CPU and memory. */
export function exitedContainer(name: string): ContainerInfo {
  return { name, state: "exited", cpuPercent: 0, memoryBytes: 0 };
}

function restartingContainer(name: string): ContainerInfo {
  return { name, state: "restarting", cpuPercent: 0, memoryBytes: 0 };
}

/** Default host CPU: 3-8 % idle load plus the containers' CPU spread over the cores. */
export function defaultHostCpu(seed: number, tick: number, containers: readonly ContainerInfo[]): number {
  const idle = jittered(seed, "host:cpu", tick, { min: 3, max: 8 });
  const load = containers.reduce((sum, c) => sum + c.cpuPercent, 0) / HOST_CORES;
  return Math.min(100, round1(idle + load));
}

/** Host memory used: the base plus the memory of every container. */
export function hostMemoryUsed(containers: readonly ContainerInfo[]): number {
  return HOST_BASE_MEMORY_BYTES + containers.reduce((sum, c) => sum + c.memoryBytes, 0);
}

/** Default filesystems: `/` 35-45 % used and `/mnt/media` 55-65 % used. */
export function defaultFilesystems(seed: number, tick: number): FilesystemUsage[] {
  const slow = Math.floor(tick / DISK_TICKS);
  const fs = (mount: string, total: number, range: Range): FilesystemUsage => ({
    mount,
    usedBytes: Math.round(total * jittered(seed, `fs:${mount}`, slow, range)),
    totalBytes: total,
  });
  return [
    fs(ROOT_MOUNT, ROOT_FS_TOTAL_BYTES, { min: 0.35, max: 0.45 }),
    fs(MEDIA_MOUNT, MEDIA_FS_TOTAL_BYTES, { min: 0.55, max: 0.65 }),
  ];
}

function hasIncident(s: SimState, type: IncidentType): boolean {
  return s.incidents.some((i) => i.type === type);
}

/** The container incident targeting `name`, if any. */
function containerIncidentFor(s: SimState, name: string): StagedIncident | undefined {
  return s.incidents.find((i) => i.target === name && isContainerIncident(i.type));
}

/** Names of every container the simulator reports in `s`, in display order. */
export function containerNames(s: SimState): string[] {
  return hasIncident(s, "cpu_spike") ? [...SIM_CONTAINER_NAMES, GHOST_CONTAINER] : [...SIM_CONTAINER_NAMES];
}

function observedContainer(s: SimState, name: string, tick: number): ContainerInfo {
  if (s.stopped.has(name)) return exitedContainer(name);
  const incident = containerIncidentFor(s, name);
  if (incident?.type === "container_crash") return exitedContainer(name);
  if (incident?.type === "container_restart_loop") return restartingContainer(name);
  const profile = SERVICE_PROFILES.find((p) => p.name === name);
  const base = profile ? defaultContainer(s.seed, profile, tick) : ghostContainer(s.seed, tick);
  if (incident?.type === "memory_leak") return { ...base, memoryBytes: base.memoryBytes + (incident.leakBytes ?? 0) };
  return base;
}

/**
 * Lowers leaked memory, in incident order, so host memory used stays at or below
 * LEAK_CAP_FRACTION even when the other containers jitter upward.
 */
function clampLeaks(s: SimState, containers: ContainerInfo[]): ContainerInfo[] {
  let excess = hostMemoryUsed(containers) - Math.floor(LEAK_CAP_FRACTION * HOST_MEMORY_TOTAL_BYTES);
  if (excess <= 0) return containers;
  const out = [...containers];
  for (const incident of s.incidents) {
    if (excess <= 0) break;
    if (incident.type !== "memory_leak") continue;
    const index = out.findIndex((c) => c.name === incident.target && c.state === "running");
    const c = out[index];
    if (!c) continue;
    const cut = Math.min(excess, incident.leakBytes ?? 0);
    out[index] = { ...c, memoryBytes: c.memoryBytes - cut };
    excess -= cut;
  }
  return out;
}

/**
 * The observed containers and host for `s` at `now`, without advancing any lazy state.
 * Incident effects are layered on top of the default model here.
 */
export function computeView(s: SimState, now: number): SimView {
  const tick = tickOf(now);
  const containers = clampLeaks(
    s,
    containerNames(s).map((name) => observedContainer(s, name, tick)),
  );
  const ghost = containers.find((c) => c.name === GHOST_CONTAINER);
  const cpuPercent =
    ghost?.state === "running"
      ? round1(jittered(s.seed, "host:cpu-spike", tick, SPIKE_CPU))
      : defaultHostCpu(s.seed, tick, containers);
  const filesystems = defaultFilesystems(s.seed, tick).map((fs) =>
    fs.mount === ROOT_MOUNT && hasIncident(s, "disk_full")
      ? { ...fs, usedBytes: Math.round(fs.totalBytes * DISK_FULL_FRACTION) }
      : fs,
  );
  const host: HostMetrics = {
    cpuPercent,
    memoryUsedBytes: hostMemoryUsed(containers),
    memoryTotalBytes: HOST_MEMORY_TOTAL_BYTES,
    filesystems,
  };
  return { containers, host };
}

/** Appends lines to a container's ring buffer, keeping the most recent LOG_BUFFER_LINES. */
export function appendLogLines(s: SimState, name: string, lines: readonly LogLine[]): SimState {
  if (lines.length === 0) return s;
  const merged = [...(s.logs.get(name) ?? []), ...lines];
  const logs = new Map(s.logs);
  logs.set(name, merged.length > LOG_BUFFER_LINES ? merged.slice(-LOG_BUFFER_LINES) : merged);
  return { ...s, logs };
}

function withCursor(s: SimState, name: string, at: number): SimState {
  const logCursor = new Map(s.logCursor);
  logCursor.set(name, at);
  return { ...s, logCursor };
}

/**
 * Generates log lines for every container from its cursor up to `now` and moves the cursor
 * to `now`. Running containers get their default service lines. A container in a staged
 * restart loop gets the startup failure line once per tick. Containers in any other state
 * get no lines; their cursor still advances, so no lines appear for the time they were
 * down. A container seen for the first time is backfilled for LOG_BACKFILL_MS.
 *
 * Callers that change a container's state (stop, restart, staging) should call this first
 * with the pre-change view, so lines up to the change are kept.
 */
export function advanceLogs(s: SimState, now: number, containers: readonly ContainerInfo[]): SimState {
  let next = s;
  let cursor: Map<string, number> | undefined;
  for (const c of containers) {
    const from = s.logCursor.get(c.name) ?? now - LOG_BACKFILL_MS;
    if (now <= from) continue;
    const start = Math.max(from, now - MAX_CATCHUP_MS);
    if (c.state === "running") {
      next = appendLogLines(next, c.name, defaultLinesBetween(s.seed, c.name, start, now));
    } else if (c.state === "restarting" && containerIncidentFor(s, c.name)?.type === "container_restart_loop") {
      next = appendLogLines(next, c.name, restartLoopLinesBetween(c.name, start, now));
    }
    cursor ??= new Map(s.logCursor);
    cursor.set(c.name, now);
  }
  return cursor ? { ...next, logCursor: cursor } : next;
}

/** Fills in logs up to `now` with the current view, before a state change. */
function settleLogs(s: SimState, now: number): { state: SimState; view: SimView } {
  const view = computeView(s, now);
  return { state: advanceLogs(s, now, view.containers), view };
}

/**
 * Grows every memory leak whose target is running by LEAK_STEP_BYTES while host memory
 * used is below LEAK_STOP_FRACTION, then holds (Requirement 3.5). Leaks are processed in
 * incident order, so two leaks never push host memory past the cap together.
 */
function growLeaks(s: SimState, view: SimView): SimState {
  if (!hasIncident(s, "memory_leak")) return s;
  let used = view.host.memoryUsedBytes;
  const stop = LEAK_STOP_FRACTION * HOST_MEMORY_TOTAL_BYTES;
  let changed = false;
  const incidents = s.incidents.map((i) => {
    if (i.type !== "memory_leak" || used >= stop) return i;
    if (!view.containers.some((c) => c.name === i.target && c.state === "running")) return i;
    used += LEAK_STEP_BYTES;
    changed = true;
    return { ...i, leakBytes: (i.leakBytes ?? 0) + LEAK_STEP_BYTES };
  });
  return changed ? { ...s, incidents } : s;
}

/** One read of the simulator: grows memory leaks, advances logs, and returns the observed view. */
export function observe(s: SimState, now: number): { state: SimState } & SimView {
  const grown = growLeaks(s, computeView(s, now));
  const view = computeView(grown, now);
  const state = advanceLogs(grown, now, view.containers);
  return { state, containers: view.containers, host: view.host };
}

/**
 * The most recent `maxLines` log lines of `name` at `now`, oldest first, after filling in
 * lazy ticks. Throws ContainerNotFoundError when the simulator does not report `name`.
 * Unlike `observe`, this advances only logs, not incident effects.
 */
export function readLogsFromState(
  s: SimState,
  name: string,
  maxLines: number,
  now: number,
): { state: SimState; lines: LogLine[] } {
  const { state, view } = settleLogs(s, now);
  if (!view.containers.some((c) => c.name === name)) throw new ContainerNotFoundError(name);
  const all = state.logs.get(name) ?? [];
  const count = Math.max(0, Math.floor(maxLines));
  return { state, lines: count === 0 ? [] : all.slice(-count) };
}

function assertListed(view: SimView, name: string): void {
  if (!view.containers.some((c) => c.name === name)) throw new ContainerNotFoundError(name);
}

function withoutStopped(s: SimState, name: string): SimState {
  if (!s.stopped.has(name)) return s;
  const stopped = new Set(s.stopped);
  stopped.delete(name);
  return { ...s, stopped };
}

/**
 * Stages an incident at `now`.
 *
 * Host incidents (`cpu_spike`, `disk_full`) take no target and are idempotent. Staging
 * `cpu_spike` while the ghost container is stopped wakes the ghost again.
 *
 * Container incidents require a target the simulator reports: a missing target throws
 * IncidentTargetRequiredError, an unknown one throws ContainerNotFoundError. A new
 * container incident replaces the target's previous one and clears a stop on the target.
 * `container_crash` appends three error lines and `container_restart_loop` one startup
 * failure line at `now`.
 */
export function stageIncident(s: SimState, type: IncidentType, target: string | undefined, now: number): SimState {
  const { state: settled, view } = settleLogs(s, now);

  if (!isContainerIncident(type)) {
    if (type === "cpu_spike") {
      const already = hasIncident(settled, "cpu_spike");
      if (already && !settled.stopped.has(GHOST_CONTAINER)) return settled;
      const base = already ? settled : { ...settled, incidents: [...settled.incidents, { type, stagedAt: now }] };
      // The ghost has no history to backfill: its logs start at the staging time.
      return withCursor(withoutStopped(base, GHOST_CONTAINER), GHOST_CONTAINER, now);
    }
    if (hasIncident(settled, type)) return settled;
    return { ...settled, incidents: [...settled.incidents, { type, stagedAt: now }] };
  }

  if (target === undefined || target.trim() === "") throw new IncidentTargetRequiredError(type);
  assertListed(view, target);

  const incident: StagedIncident =
    type === "memory_leak" ? { type, target, stagedAt: now, leakBytes: 0 } : { type, target, stagedAt: now };
  let next: SimState = withoutStopped(
    {
      ...settled,
      incidents: [...settled.incidents.filter((i) => !(i.target === target && isContainerIncident(i.type))), incident],
    },
    target,
  );
  if (type === "container_crash") next = appendLogLines(next, target, crashLines(now));
  if (type === "container_restart_loop") next = appendLogLines(next, target, [restartLoopLine(target, now)]);
  return next;
}

/**
 * Restarts `name` (Requirement 3.9): clears its stop and every incident targeting it, so it
 * reports `running`. Restarting the ghost container removes `cpu_spike`, which removes the
 * ghost container from the list. Throws ContainerNotFoundError for an unlisted name.
 */
export function restartContainer(s: SimState, name: string, now: number): SimState {
  const { state: settled, view } = settleLogs(s, now);
  assertListed(view, name);
  const incidents = settled.incidents.filter(
    (i) => i.target !== name && !(name === GHOST_CONTAINER && i.type === "cpu_spike"),
  );
  return withoutStopped({ ...settled, incidents }, name);
}

/**
 * Stops `name` (Requirement 3.11): it reports `exited` and its container incidents are
 * removed. Stopping the ghost container ends the host CPU effect of `cpu_spike` while the
 * ghost stays listed as `exited`. Throws ContainerNotFoundError for an unlisted name.
 */
export function stopContainer(s: SimState, name: string, now: number): SimState {
  const { state: settled, view } = settleLogs(s, now);
  assertListed(view, name);
  const incidents = settled.incidents.filter((i) => !(i.target === name && isContainerIncident(i.type)));
  const stopped = new Set(settled.stopped);
  stopped.add(name);
  return { ...settled, incidents, stopped };
}

/**
 * Clears every incident and stop (Requirement 3.10). Logs are kept as history; every
 * container and the host return to the default model.
 */
export function clearIncidents(s: SimState, now: number): SimState {
  const { state: settled } = settleLogs(s, now);
  return { ...settled, incidents: [], stopped: new Set() };
}
