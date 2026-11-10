import { describe, expect, it } from "vitest";
import { REDACTED, scrubDeep } from "../../../src/server/logging/scrub.js";

const KEY = "sk-or-v1-abc123.*+?^$";

describe("scrubDeep", () => {
  it("replaces every occurrence in a string, including regex metacharacters", () => {
    expect(scrubDeep(`a ${KEY} b ${KEY}`, [KEY])).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("scrubs nested objects and arrays without mutating the input", () => {
    const input = { a: [{ b: `Bearer ${KEY}` }], n: 3, ok: true, nil: null };
    const out = scrubDeep(input, [KEY]);
    expect(out).toEqual({ a: [{ b: `Bearer ${REDACTED}` }], n: 3, ok: true, nil: null });
    expect(input.a[0]?.b).toBe(`Bearer ${KEY}`);
  });

  it("scrubs object keys, Maps, and Sets", () => {
    const out = scrubDeep({ [KEY]: 1, m: new Map([["k", KEY]]), s: new Set([KEY]) }, [KEY]);
    expect(Object.keys(out)).toContain(REDACTED);
    expect(out.m.get("k")).toBe(REDACTED);
    expect([...out.s]).toEqual([REDACTED]);
  });

  it("scrubs Error message, stack, cause, and own properties and keeps the prototype", () => {
    const err = new TypeError(`bad key ${KEY}`, { cause: new Error(`inner ${KEY}`) });
    (err as unknown as Record<string, unknown>).detail = { token: KEY };
    const out = scrubDeep(err, [KEY]);
    expect(out).toBeInstanceOf(TypeError);
    expect(out.message).toBe(`bad key ${REDACTED}`);
    expect(out.stack).not.toContain(KEY);
    expect((out.cause as Error).message).toBe(`inner ${REDACTED}`);
    expect((out as unknown as { detail: { token: string } }).detail.token).toBe(REDACTED);
    expect(err.message).toContain(KEY);
  });

  it("handles cycles", () => {
    const a: Record<string, unknown> = { s: KEY };
    a.self = a;
    const out = scrubDeep(a, [KEY]);
    expect(out.s).toBe(REDACTED);
    expect(out.self).toBe(out);
  });

  it("replaces the longer secret whole when one secret contains another", () => {
    expect(scrubDeep("xx-secret-long", ["secret", "xx-secret-long"])).toBe(REDACTED);
  });

  it("ignores empty secrets and leaves non-string primitives alone", () => {
    expect(scrubDeep("abc", [""])).toBe("abc");
    expect(scrubDeep(42, [KEY])).toBe(42);
    expect(scrubDeep(undefined, [KEY])).toBeUndefined();
  });
});
