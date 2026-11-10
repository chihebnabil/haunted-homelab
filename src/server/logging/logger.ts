import { pino, type DestinationStream, type LogFn, type Logger } from "pino";
import { REDACTED, scrubDeep } from "./scrub.js";

export type { Logger } from "pino";

/** Paths censored by pino's redaction, in addition to value-based scrubbing. */
export const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "headers.authorization",
  "headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
] as const;

/**
 * Creates the backend logger. Every log call has its arguments scrubbed of each secret
 * (value-based), the merged log object and child bindings are scrubbed too, and known
 * secret-bearing paths are censored by pino's `redact`.
 *
 * @param secrets values to remove from every log line (the OpenRouter API key)
 * @param destination optional output stream; defaults to stdout
 */
export function createLogger(secrets: readonly string[], destination?: DestinationStream): Logger {
  const list = [...secrets];
  const options = {
    level: "info",
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
        const scrubbed = scrubDeep(args, list) as Parameters<LogFn>;
        method.apply(this, scrubbed);
      },
    },
    formatters: {
      log: (object: Record<string, unknown>) => scrubDeep(object, list),
    },
  };
  const logger = destination ? pino(options, destination) : pino(options);

  // pino applies formatters.bindings only to the root logger, so child bindings are scrubbed here.
  // Child loggers are created with Object.create(parent), so they inherit these overrides.
  const baseChild = logger.child;
  const baseSetBindings = logger.setBindings;
  logger.child = function (this: Logger, bindings, childOptions) {
    return baseChild.call(this, scrubDeep(bindings, list), childOptions);
  } as Logger["child"];
  logger.setBindings = function (this: Logger, bindings) {
    baseSetBindings.call(this, scrubDeep(bindings, list));
  } as Logger["setBindings"];
  return logger;
}
