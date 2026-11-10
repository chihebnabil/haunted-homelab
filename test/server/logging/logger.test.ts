import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/server/logging/logger.js";

const KEY = "sk-or-v1-0123456789abcdef";

function capture(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join("").split("\n").filter((l) => l.length > 0) };
}

describe("createLogger", () => {
  it("keeps the createLogger(secrets) signature", () => {
    const logger = createLogger([KEY]);
    expect(typeof logger.info).toBe("function");
  });

  it("scrubs the secret from messages, format arguments, objects, and errors", () => {
    const { stream, lines } = capture();
    const logger = createLogger([KEY], stream);
    logger.info(`message with ${KEY}`);
    logger.info("format %s", KEY);
    logger.info({ nested: { value: `x${KEY}x` } }, "object");
    logger.error(new Error(`provider said ${KEY}`));
    logger.error({ err: new Error(`wrapped ${KEY}`) }, "wrapped");
    logger.child({ bound: KEY }).warn("child");
    logger.child({ a: 1 }).child({ grand: KEY }).warn("grandchild");

    const out = lines();
    expect(out).toHaveLength(7);
    for (const line of out) expect(line).not.toContain(KEY);
    expect(out.join("\n")).toContain("[REDACTED]");
  });

  it("redacts apiKey and authorization header paths even when the value is not a known secret", () => {
    const { stream, lines } = capture();
    const logger = createLogger([], stream);
    logger.info({ cfg: { apiKey: "other-key" }, req: { headers: { authorization: "Bearer other", Authorization: "Bearer other2" } } });
    logger.info({ apiKey: "top-level", headers: { authorization: "Bearer top" } });

    const out = lines().join("\n");
    expect(out).not.toContain("other-key");
    expect(out).not.toContain("Bearer other");
    expect(out).not.toContain("top-level");
    expect(out).not.toContain("Bearer top");
  });
});
