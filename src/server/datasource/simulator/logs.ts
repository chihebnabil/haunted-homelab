/**
 * Synthetic Container_Log lines for the Simulator_Source (Requirement 3.2).
 *
 * Every tick, each running container gains one or two lines. The lines of a tick are
 * a pure function of (seed, container name, tick), and their timestamps fall inside
 * that tick, so any 10-second window holds at least one line per running container.
 * Default templates contain no error keywords; a few contain warnings for realism.
 */

import type { LogLine } from "../../../shared/types.js";
import { rngFor, TICK_MS, tickOf } from "./noise.js";

type Rng = () => number;
type Template = (r: Rng) => string;

function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)] as T;
}

function int(r: Rng, min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1));
}

const TITLES = ["The Shining", "Ghostbusters", "The Others", "Poltergeist", "Beetlejuice", "Crimson Peak"];
const PLEX_USERS = ["morticia", "gomez", "wednesday", "lurch"];
const DOMAINS = ["example.com", "github.com", "api.weather.gov", "plex.tv", "time.cloudflare.com", "updates.home-assistant.io"];
const AD_DOMAINS = ["ads.doubleclick.net", "tracker.adnxs.com", "pixel.facebook.com", "metrics.tiktokv.com"];
const ENTITIES = ["sensor.living_room_temperature", "sensor.attic_humidity", "binary_sensor.front_door", "light.hallway"];
const AUTOMATIONS = ["Hallway lights at dusk", "Lock doors at midnight", "Attic fan control", "Porch light on motion"];
const PATHS = ["/", "/api/status", "/web/index.html", "/admin/api.php", "/dashboard", "/favicon.ico"];
const MONITORS = ["Plex", "Pi-hole", "Home Assistant", "Nginx Proxy", "Router"];

const lanIp = (r: Rng) => `192.168.1.${int(r, 2, 254)}`;

export const SERVICE_LOG_TEMPLATES: Readonly<Record<string, readonly Template[]>> = {
  plex: [
    (r) => `Transcoder session started for "${pick(r, TITLES)}" (${pick(r, ["1080p", "720p", "4K"])})`,
    (r) => `Library scan complete: ${int(r, 200, 1800)} items in Movies`,
    (r) => `Client ${lanIp(r)} started streaming "${pick(r, TITLES)}"`,
    (r) => `Direct play session ended for ${pick(r, PLEX_USERS)}`,
    (r) => `Refreshing metadata for "${pick(r, TITLES)}"`,
    (r) => `WARN: Slow transcode for "${pick(r, TITLES)}", buffering on client ${lanIp(r)}`,
  ],
  pihole: [
    (r) => `query[A] ${pick(r, DOMAINS)} from ${lanIp(r)}`,
    (r) => `forwarded ${pick(r, DOMAINS)} to 1.1.1.1`,
    (r) => `cached ${pick(r, DOMAINS)} is 104.16.${int(r, 0, 255)}.${int(r, 1, 254)}`,
    (r) => `gravity blocked ${pick(r, AD_DOMAINS)} is 0.0.0.0`,
    (r) => `query[AAAA] ${pick(r, DOMAINS)} from ${lanIp(r)}`,
  ],
  homeassistant: [
    (r) => `INFO (MainThread) [homeassistant.components.automation] Automation '${pick(r, AUTOMATIONS)}' triggered`,
    (r) => `INFO (MainThread) [homeassistant.core] State of ${pick(r, ENTITIES)} changed`,
    (r) => `INFO (MainThread) [homeassistant.core] Service light.turn_${pick(r, ["on", "off"])} called`,
    (r) => `INFO (MainThread) [homeassistant.components.recorder] Purged ${int(r, 10, 500)} old states`,
    () => `WARNING (MainThread) [homeassistant.components.zha] Device setup is taking longer than expected`,
  ],
  "nginx-proxy": [
    (r) =>
      `${lanIp(r)} - - "GET ${pick(r, PATHS)} HTTP/1.1" ${pick(r, [200, 200, 200, 304])} ${int(r, 120, 48000)}`,
    (r) => `${lanIp(r)} - - "POST /api/websocket HTTP/1.1" 101 0`,
    () => `[notice] signal process started`,
    () => `[warn] an upstream response is buffered to a temporary file`,
  ],
  "uptime-kuma": [
    (r) => `[MONITOR] INFO: Monitor "${pick(r, MONITORS)}" is UP, ping ${int(r, 1, 80)} ms`,
    (r) => `[MONITOR] INFO: Heartbeat recorded for "${pick(r, MONITORS)}"`,
    () => `[SERVER] INFO: Checking for updates`,
  ],
};

/** Used for containers without their own templates (for example the cpu_spike ghost container). */
export const GENERIC_LOG_TEMPLATES: readonly Template[] = [
  (r) => `worker ${int(r, 1, 16)} heartbeat ok`,
  () => `idle, waiting for work`,
  (r) => `processed ${int(r, 1, 900)} jobs`,
];

function templatesFor(name: string): readonly Template[] {
  return SERVICE_LOG_TEMPLATES[name] ?? GENERIC_LOG_TEMPLATES;
}

/**
 * The default log lines of `name` for `tick`: one or two lines, oldest first.
 * The first line is in the first half of the tick and the second in the second half.
 */
export function defaultLinesForTick(seed: number, name: string, tick: number): LogLine[] {
  const r = rngFor(seed, `log:${name}`, tick);
  const start = tick * TICK_MS;
  const half = TICK_MS / 2;
  const count = r() < 0.5 ? 1 : 2;
  const templates = templatesFor(name);
  const lines: LogLine[] = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * half + Math.floor(r() * half);
    lines.push({ timestamp: new Date(at).toISOString(), text: pick(r, templates)(r), stream: "stdout" });
  }
  return lines;
}

/** Default log lines of `name` with timestamps in (fromExclusive, toInclusive], oldest first. */
export function defaultLinesBetween(
  seed: number,
  name: string,
  fromExclusive: number,
  toInclusive: number,
): LogLine[] {
  if (toInclusive <= fromExclusive) return [];
  const out: LogLine[] = [];
  for (let tick = tickOf(fromExclusive); tick <= tickOf(toInclusive); tick++) {
    for (const line of defaultLinesForTick(seed, name, tick)) {
      const at = Date.parse(line.timestamp);
      if (at > fromExclusive && at <= toInclusive) out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Incident log lines (Requirements 3.7, 3.8)
// ---------------------------------------------------------------------------

/** Lines appended once when a container_crash incident is staged. Each is classified as an error. */
export const CRASH_LOG_TEXTS: readonly string[] = [
  "ERROR: worker thread received signal 11 (SIGSEGV)",
  "FATAL: unhandled exception in worker thread: segmentation fault",
  "ERROR: main process exited with code 139, container stopped",
];

/** The crash lines, all stamped at `at`, on stderr. */
export function crashLines(at: number): LogLine[] {
  const timestamp = new Date(at).toISOString();
  return CRASH_LOG_TEXTS.map((text) => ({ timestamp, text, stream: "stderr" as const }));
}

const SERVICE_PORTS: Readonly<Record<string, number>> = {
  plex: 32400,
  pihole: 53,
  homeassistant: 8123,
  "nginx-proxy": 443,
  "uptime-kuma": 3001,
};

/** The repeated startup failure line of a container in a restart loop. */
export function restartLoopText(name: string): string {
  return `ERROR: startup failed: could not bind to port ${SERVICE_PORTS[name] ?? 8080}, retrying`;
}

/** One restart-loop line at `at`. */
export function restartLoopLine(name: string, at: number): LogLine {
  return { timestamp: new Date(at).toISOString(), text: restartLoopText(name), stream: "stderr" };
}

/**
 * Restart-loop lines of `name` with timestamps in (fromExclusive, toInclusive]:
 * one line at the start of every tick, oldest first.
 */
export function restartLoopLinesBetween(name: string, fromExclusive: number, toInclusive: number): LogLine[] {
  if (toInclusive <= fromExclusive) return [];
  const out: LogLine[] = [];
  for (let tick = tickOf(fromExclusive); tick <= tickOf(toInclusive); tick++) {
    const at = tick * TICK_MS;
    if (at > fromExclusive && at <= toInclusive) out.push(restartLoopLine(name, at));
  }
  return out;
}
