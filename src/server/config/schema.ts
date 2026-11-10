import { z } from "zod";
import type { DataSourceName } from "../../shared/types.js";

export const DATA_SOURCE_NAMES = ["docker", "simulator"] as const satisfies readonly DataSourceName[];

// Compile-time check that DATA_SOURCE_NAMES covers every DataSourceName.
type MissingDataSource = Exclude<DataSourceName, (typeof DATA_SOURCE_NAMES)[number]>;
const _allDataSourcesListed: [MissingDataSource] extends [never] ? true : never = true;
void _allDataSourcesListed;

export interface Config {
  openrouter: { apiKey: string; baseUrl: string };
  llm: { model: string };
  /** An empty or whitespace-only instructions string resolves to undefined. */
  tts: { model: string; voice: string; instructions?: string };
  dataSource: DataSourceName;
  docker: { endpoint: string };
  monitor: { pollIntervalMs: number };
  thresholds: { cpuPercent: number; cpuDurationSeconds: number; memoryPercent: number; diskPercent: number };
  /** `allowedOrigins`: public origins (scheme://host[:port]) the origin guard accepts in addition to loopback. */
  server: { host: string; port: number; allowedOrigins: string[] };
  simulator: { seed: number };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

export type SettingKind = "string" | "integer" | "number";

export interface SettingSpec {
  /** Environment variable name. */
  env: string;
  /** Platform-provided variable read when `env` is unset, such as `PORT` on Render. */
  fallbackEnv?: string;
  /** Dotted config file key, e.g. "openrouter.apiKey". */
  key: string;
  kind: SettingKind;
  /** Documented default. Undefined means the setting is required. */
  default?: string | number | ((platform: string) => string);
}

export const DEFAULT_TTS_INSTRUCTIONS =
  "Speak slowly in a hollow, eerie whisper, like a ghost trapped in the machine.";

export function defaultDockerEndpoint(platform: string): string {
  return platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

/** Every configurable setting, in the order problems are reported. */
export const SETTINGS = [
  { env: "HAUNTED_OPENROUTER_API_KEY", key: "openrouter.apiKey", kind: "string" },
  { env: "HAUNTED_OPENROUTER_BASE_URL", key: "openrouter.baseUrl", kind: "string", default: "https://openrouter.ai/api/v1" },
  { env: "HAUNTED_LLM_MODEL", key: "llm.model", kind: "string", default: "openai/gpt-4o-mini" },
  { env: "HAUNTED_TTS_MODEL", key: "tts.model", kind: "string", default: "openai/gpt-4o-mini-tts-2025-12-15" },
  { env: "HAUNTED_TTS_VOICE", key: "tts.voice", kind: "string", default: "onyx" },
  { env: "HAUNTED_TTS_INSTRUCTIONS", key: "tts.instructions", kind: "string", default: DEFAULT_TTS_INSTRUCTIONS },
  { env: "HAUNTED_DATA_SOURCE", key: "dataSource", kind: "string", default: "simulator" },
  { env: "HAUNTED_DOCKER_ENDPOINT", key: "docker.endpoint", kind: "string", default: defaultDockerEndpoint },
  { env: "HAUNTED_POLL_INTERVAL_MS", key: "monitor.pollIntervalMs", kind: "integer", default: 5000 },
  { env: "HAUNTED_CPU_THRESHOLD", key: "thresholds.cpuPercent", kind: "number", default: 90 },
  { env: "HAUNTED_CPU_DURATION_S", key: "thresholds.cpuDurationSeconds", kind: "number", default: 30 },
  { env: "HAUNTED_MEMORY_THRESHOLD", key: "thresholds.memoryPercent", kind: "number", default: 90 },
  { env: "HAUNTED_DISK_THRESHOLD", key: "thresholds.diskPercent", kind: "number", default: 90 },
  { env: "HAUNTED_HOST", key: "server.host", kind: "string", default: "127.0.0.1" },
  { env: "HAUNTED_PORT", fallbackEnv: "PORT", key: "server.port", kind: "integer", default: 3000 },
  {
    env: "HAUNTED_ALLOWED_ORIGINS",
    fallbackEnv: "RENDER_EXTERNAL_URL",
    key: "server.allowedOrigins",
    kind: "string",
    default: "",
  },
  { env: "HAUNTED_SIM_SEED", key: "simulator.seed", kind: "integer", default: 1337 },
] as const satisfies readonly SettingSpec[];

// ---------------------------------------------------------------------------
// zod schema. Messages name the setting so ConfigError output is actionable.
// ---------------------------------------------------------------------------

function settingFor(key: string): SettingSpec {
  const spec = SETTINGS.find((s) => s.key === key);
  if (!spec) throw new Error(`No setting registered for config key ${key}`);
  return spec;
}

function label(key: string): string {
  return `${settingFor(key).env} (config file key "${key}")`;
}

function typeError(key: string, expected: string) {
  return (iss: { input: unknown }) =>
    iss.input === undefined ? `${label(key)} is required` : `${label(key)} must be ${expected}`;
}

function nonEmptyString(key: string) {
  return z
    .string({ error: typeError(key, "a string") })
    .refine((s) => s.trim().length > 0, { error: `${label(key)} must not be empty`, abort: true });
}

function numberIn(key: string, opts: { min: number; max?: number; integer?: boolean }) {
  const expected = opts.integer ? "an integer" : "a number";
  const range =
    opts.max === undefined ? `at least ${opts.min}` : `between ${opts.min} and ${opts.max}`;
  return z
    .number({ error: typeError(key, expected) })
    .refine((n) => Number.isFinite(n) && (!opts.integer || Number.isInteger(n)), {
      error: `${label(key)} must be ${expected}`,
      abort: true,
    })
    .refine((n) => n >= opts.min && (opts.max === undefined || n <= opts.max), {
      error: `${label(key)} must be ${range}`,
    });
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const DOCKER_ENDPOINT_SCHEMES = ["unix://", "npipe://", "tcp://", "http://", "https://"];

/** The origin (scheme://host[:port]) of an http or https URL, or undefined when it is not one. */
function toOrigin(entry: string): string | undefined {
  try {
    const u = new URL(entry);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** A comma-separated string (environment) or a list (config file) of origins, normalized and deduplicated. */
const allowedOriginsSchema = z
  .union([z.string(), z.array(z.string())], {
    error: `${label("server.allowedOrigins")} must be a comma-separated string or a list of origins`,
  })
  .transform((value, ctx) => {
    const entries = (Array.isArray(value) ? value : value.split(","))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const origins: string[] = [];
    for (const entry of entries) {
      const origin = toOrigin(entry);
      if (origin === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${label("server.allowedOrigins")} has an invalid origin ${JSON.stringify(entry)}. Use a value like https://haunted.example.com`,
        });
      } else if (!origins.includes(origin)) {
        origins.push(origin);
      }
    }
    return origins;
  });

export const ConfigSchema = z.object({
  openrouter: z.object({
    apiKey: z
      .string({
        error: (iss) =>
          iss.input === undefined
            ? `HAUNTED_OPENROUTER_API_KEY is missing. Set it in the environment or as "openrouter.apiKey" in the config file.`
            : `${label("openrouter.apiKey")} must be a string`,
      })
      .refine((s) => s.trim().length > 0, {
        error: `HAUNTED_OPENROUTER_API_KEY is empty. Set it in the environment or as "openrouter.apiKey" in the config file.`,
      }),
    baseUrl: nonEmptyString("openrouter.baseUrl").refine(isHttpUrl, {
      error: `${label("openrouter.baseUrl")} must be an http or https URL`,
    }),
  }),
  llm: z.object({ model: nonEmptyString("llm.model") }),
  tts: z.object({
    model: nonEmptyString("tts.model"),
    voice: nonEmptyString("tts.voice"),
    instructions: z
      .string({ error: typeError("tts.instructions", "a string") })
      .optional()
      .transform((s) => (s !== undefined && s.trim().length > 0 ? s : undefined)),
  }),
  dataSource: z.enum(DATA_SOURCE_NAMES, {
    error: (iss) =>
      `Unknown data source ${JSON.stringify(String(iss.input))}. Valid data sources: ${DATA_SOURCE_NAMES.join(", ")}`,
  }),
  docker: z.object({
    endpoint: nonEmptyString("docker.endpoint").refine(
      (s) => DOCKER_ENDPOINT_SCHEMES.some((scheme) => s.startsWith(scheme)),
      { error: `${label("docker.endpoint")} must start with one of ${DOCKER_ENDPOINT_SCHEMES.join(", ")}` },
    ),
  }),
  monitor: z.object({
    pollIntervalMs: numberIn("monitor.pollIntervalMs", { min: 1000, integer: true }),
  }),
  thresholds: z.object({
    cpuPercent: numberIn("thresholds.cpuPercent", { min: 1, max: 100 }),
    cpuDurationSeconds: numberIn("thresholds.cpuDurationSeconds", { min: 0 }),
    memoryPercent: numberIn("thresholds.memoryPercent", { min: 1, max: 100 }),
    diskPercent: numberIn("thresholds.diskPercent", { min: 1, max: 100 }),
  }),
  server: z.object({
    host: nonEmptyString("server.host"),
    port: numberIn("server.port", { min: 1, max: 65535, integer: true }),
    allowedOrigins: allowedOriginsSchema,
  }),
  simulator: z.object({
    seed: numberIn("simulator.seed", {
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
    }),
  }),
}) satisfies z.ZodType<Config>;
