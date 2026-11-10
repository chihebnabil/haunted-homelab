export const REDACTED = "[REDACTED]";

/**
 * Returns a copy of `value` in which every occurrence of each non-empty secret is
 * replaced with "[REDACTED]". Walks strings, arrays, plain and class objects, Maps,
 * Sets, and Errors (message, stack, cause, and own properties). Handles cycles.
 * The input is never mutated.
 */
export function scrubDeep<T>(value: T, secrets: readonly string[]): T {
  // Longest first, so a secret that contains a shorter secret is replaced whole.
  const active = [...new Set(secrets.filter((s) => typeof s === "string" && s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (active.length === 0) return value;
  return walk(value, active, new WeakMap()) as T;
}

function scrubString(s: string, secrets: readonly string[]): string {
  let out = s;
  // split/join avoids treating secrets as regular expressions.
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

function walk(value: unknown, secrets: readonly string[], seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return scrubString(value, secrets);
  if (value === null || typeof value !== "object") return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(walk(item, secrets, seen));
    return out;
  }

  if (value instanceof Error) return scrubError(value, secrets, seen);

  // Values that cannot carry text we need to rewrite.
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }

  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(value, out);
    for (const [k, v] of value) out.set(walk(k, secrets, seen), walk(v, secrets, seen));
    return out;
  }

  if (value instanceof Set) {
    const out = new Set<unknown>();
    seen.set(value, out);
    for (const v of value) out.add(walk(v, secrets, seen));
    return out;
  }

  // Objects with toJSON (other than Date) are serialized through it, so scrub its result.
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    let json: unknown;
    try {
      json = toJSON.call(value);
    } catch {
      json = undefined;
    }
    if (json !== value) {
      const out = walk(json, secrets, seen);
      seen.set(value, out);
      return out;
    }
  }

  // Class instances become plain objects with the same enumerable data. Logs only need the data,
  // and keeping the prototype could run methods that depend on fields that were not copied.
  const out: Record<string, unknown> =
    Object.getPrototypeOf(value) === null ? (Object.create(null) as Record<string, unknown>) : {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    let v: unknown;
    try {
      v = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    out[scrubString(key, secrets)] = walk(v, secrets, seen);
  }
  return out;
}

function scrubError(err: Error, secrets: readonly string[], seen: WeakMap<object, unknown>): Error {
  // Keep the prototype so instanceof checks and pino's error serializer still work.
  const out = Object.create(Object.getPrototypeOf(err) as object) as Error;
  seen.set(err, out);

  const define = (key: string, v: unknown): void => {
    Object.defineProperty(out, key, { value: v, writable: true, configurable: true, enumerable: false });
  };

  define("message", scrubString(String(err.message ?? ""), secrets));
  if (typeof err.stack === "string") define("stack", scrubString(err.stack, secrets));
  if (Object.prototype.hasOwnProperty.call(err, "name")) define("name", walk(err.name, secrets, seen));
  if ("cause" in err && err.cause !== undefined) define("cause", walk(err.cause, secrets, seen));
  if (err instanceof AggregateError) define("errors", walk(err.errors, secrets, seen));

  for (const key of Object.keys(err)) {
    if (key === "message" || key === "stack" || key === "cause") continue;
    let v: unknown;
    try {
      v = (err as unknown as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    (out as unknown as Record<string, unknown>)[scrubString(key, secrets)] = walk(v, secrets, seen);
  }
  return out;
}
