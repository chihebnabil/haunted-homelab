import { ConfigError, ConfigSchema, SETTINGS, type Config, type SettingSpec } from "./schema.js";

export interface LoadConfigOptions {
  /** Platform used for the Docker endpoint default. Defaults to process.platform. */
  platform?: string;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accepts decimal numbers only: no hex, exponents, units, or empty strings. */
const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function parseStrictNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!STRICT_NUMBER.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function expectedKind(spec: SettingSpec): string {
  return spec.kind === "integer" ? "an integer" : spec.kind === "number" ? "a number" : "a string";
}

/**
 * Reads a dotted key from the config file object. A null value counts as absent.
 * Reports an intermediate key that is present but not an object, once per prefix.
 */
function readFileValue(
  file: PlainObject,
  key: string,
  problems: string[],
  reportedPrefixes: Set<string>,
): unknown {
  const parts = key.split(".");
  let current: unknown = file;
  for (let i = 0; i < parts.length; i++) {
    if (current === undefined || current === null) return undefined;
    if (!isPlainObject(current)) {
      const prefix = parts.slice(0, i).join(".");
      if (!reportedPrefixes.has(prefix)) {
        reportedPrefixes.add(prefix);
        problems.push(`Config file key "${prefix}" must be an object`);
      }
      return undefined;
    }
    current = current[parts[i]!];
  }
  return current === null ? undefined : current;
}

function setPath(target: PlainObject, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (isPlainObject(next)) {
      node = next;
    } else {
      const created: PlainObject = {};
      node[part] = created;
      node = created;
    }
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * Resolves the configuration with precedence environment > config file > default.
 * Pure: the caller passes process.env and the parsed config file (or undefined).
 * Collects every problem and throws a single ConfigError listing all of them.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  file: unknown,
  options: LoadConfigOptions = {},
): Config {
  const platform = options.platform ?? process.platform;
  const problems: string[] = [];
  /** Keys whose raw value was already reported, so the schema does not report them again. */
  const flagged = new Set<string>();
  const reportedPrefixes = new Set<string>();

  let fileObj: PlainObject = {};
  if (isPlainObject(file)) {
    fileObj = file;
  } else if (file !== undefined && file !== null) {
    problems.push("Config file must contain a JSON object");
  }

  const raw: PlainObject = {};
  for (const spec of SETTINGS as readonly SettingSpec[]) {
    // The HAUNTED_ variable wins over a platform fallback such as PORT; both win over the file.
    const envName =
      env[spec.env] !== undefined
        ? spec.env
        : spec.fallbackEnv !== undefined && env[spec.fallbackEnv] !== undefined
          ? spec.fallbackEnv
          : undefined;
    const envValue = envName === undefined ? undefined : env[envName];
    let value: unknown;

    if (envValue !== undefined) {
      if (spec.kind === "string") {
        value = envValue;
      } else {
        const n = parseStrictNumber(envValue);
        if (n === undefined) {
          problems.push(`${envName} must be ${expectedKind(spec)}, got ${JSON.stringify(envValue)}`);
          flagged.add(spec.key);
          continue;
        }
        value = n;
      }
    } else {
      const fileValue = readFileValue(fileObj, spec.key, problems, reportedPrefixes);
      if (fileValue !== undefined) {
        value = fileValue;
      } else {
        value = typeof spec.default === "function" ? spec.default({ platform, env }) : spec.default;
      }
    }

    if (value !== undefined) setPath(raw, spec.key, value);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      // Skip issues for flagged keys, and for parent objects left empty because their keys were flagged.
      const alreadyReported = [...flagged].some((k) => k === path || k.startsWith(`${path}.`));
      if (alreadyReported) continue;
      problems.push(issue.message);
    }
  }

  if (problems.length > 0 || !parsed.success) throw new ConfigError(problems);
  return parsed.data;
}
