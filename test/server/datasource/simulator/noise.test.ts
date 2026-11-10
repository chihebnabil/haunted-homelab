import { describe, expect, it } from "vitest";
import { fnv1a, mulberry32, noise, tickOf, TICK_MS } from "../../../../src/server/datasource/simulator/noise.js";

describe("noise", () => {
  it("fnv1a matches the reference 32-bit FNV-1a values", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("mulberry32 is deterministic and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("is a pure function of seed, key, and tick", () => {
    expect(noise(1337, "cpu:plex", 10)).toBe(noise(1337, "cpu:plex", 10));
    expect(noise(1337, "cpu:plex", 10)).not.toBe(noise(1337, "cpu:plex", 11));
    expect(noise(1337, "cpu:plex", 10)).not.toBe(noise(1338, "cpu:plex", 10));
    expect(noise(1337, "cpu:plex", 10)).not.toBe(noise(1337, "cpu:pihole", 10));
  });

  it("tickOf uses 5-second ticks", () => {
    expect(TICK_MS).toBe(5000);
    expect(tickOf(0)).toBe(0);
    expect(tickOf(4999)).toBe(0);
    expect(tickOf(5000)).toBe(1);
    expect(tickOf(-1)).toBe(-1);
  });
});
