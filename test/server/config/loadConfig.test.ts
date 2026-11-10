import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/server/config/loadConfig.js";
import { ConfigError, DEFAULT_TTS_INSTRUCTIONS } from "../../../src/server/config/schema.js";
import { toPublicConfig } from "../../../src/server/config/publicConfig.js";

const KEY = "sk-or-v1-test-key-123";

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("applies documented defaults when only the API key is set", () => {
    const c = loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY }, undefined, { platform: "linux" });
    expect(c).toEqual({
      openrouter: { apiKey: KEY, baseUrl: "https://openrouter.ai/api/v1" },
      llm: { model: "openai/gpt-4o-mini" },
      tts: { model: "openai/gpt-4o-mini-tts-2025-12-15", voice: "onyx", instructions: DEFAULT_TTS_INSTRUCTIONS },
      dataSource: "simulator",
      docker: { endpoint: "unix:///var/run/docker.sock" },
      monitor: { pollIntervalMs: 5000 },
      thresholds: { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 },
      server: { host: "127.0.0.1", port: 3000, allowedOrigins: [] },
      simulator: { seed: 1337 },
    });
  });

  it("uses the named pipe Docker endpoint on Windows", () => {
    const c = loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY }, undefined, { platform: "win32" });
    expect(c.docker.endpoint).toBe("npipe:////./pipe/docker_engine");
  });

  it("prefers environment over file and file over default", () => {
    const c = loadConfig(
      { HAUNTED_LLM_MODEL: "anthropic/claude-3.5-haiku", HAUNTED_PORT: "8080" },
      {
        openrouter: { apiKey: KEY },
        llm: { model: "openai/gpt-4o" },
        server: { port: 4000, host: "0.0.0.0" },
        thresholds: { cpuPercent: 75 },
      },
    );
    expect(c.llm.model).toBe("anthropic/claude-3.5-haiku");
    expect(c.server.port).toBe(8080);
    expect(c.server.host).toBe("0.0.0.0");
    expect(c.thresholds.cpuPercent).toBe(75);
    expect(c.thresholds.memoryPercent).toBe(90);
    expect(c.openrouter.apiKey).toBe(KEY);
  });

  it("listens on all interfaces on Render unless HAUNTED_HOST or the file says otherwise", () => {
    const render = { HAUNTED_OPENROUTER_API_KEY: KEY, RENDER: "true" };
    expect(loadConfig(render, undefined).server.host).toBe("0.0.0.0");
    expect(loadConfig({ ...render, HAUNTED_HOST: "127.0.0.1" }, undefined).server.host).toBe("127.0.0.1");
    expect(loadConfig(render, { server: { host: "10.0.0.5" } }).server.host).toBe("10.0.0.5");
    expect(loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY, RENDER: "false" }, undefined).server.host).toBe("127.0.0.1");
  });

  it("uses the platform PORT when HAUNTED_PORT is unset, and HAUNTED_PORT wins when both are set", () => {
    const base = { HAUNTED_OPENROUTER_API_KEY: KEY, PORT: "10000" };
    expect(loadConfig(base, { server: { port: 4000 } }).server.port).toBe(10000);
    expect(loadConfig({ ...base, HAUNTED_PORT: "8080" }, undefined).server.port).toBe(8080);
    expect(() => loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY, PORT: "abc" }, undefined)).toThrow(
      /PORT must be an integer, got "abc"/,
    );
  });

  it("parses, normalizes, and deduplicates allowed origins", () => {
    const c = loadConfig(
      {
        HAUNTED_OPENROUTER_API_KEY: KEY,
        HAUNTED_ALLOWED_ORIGINS: " https://ghost.example.com/ , http://192.168.1.20:3000,https://ghost.example.com",
      },
      undefined,
    );
    expect(c.server.allowedOrigins).toEqual(["https://ghost.example.com", "http://192.168.1.20:3000"]);
    const fromFile = loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY }, { server: { allowedOrigins: ["https://a.example"] } });
    expect(fromFile.server.allowedOrigins).toEqual(["https://a.example"]);
  });

  it("allows Render's external URL by default and lets HAUNTED_ALLOWED_ORIGINS replace it", () => {
    const render = { HAUNTED_OPENROUTER_API_KEY: KEY, RENDER_EXTERNAL_URL: "https://haunted-homelab.onrender.com" };
    expect(loadConfig(render, undefined).server.allowedOrigins).toEqual(["https://haunted-homelab.onrender.com"]);
    expect(
      loadConfig({ ...render, HAUNTED_ALLOWED_ORIGINS: "https://ghost.example.com" }, undefined).server.allowedOrigins,
    ).toEqual(["https://ghost.example.com"]);
  });

  it.each(["*", "ghost.example.com", "ftp://ghost.example.com", "https://user:pw@ghost.example.com"])(
    "rejects the allowed origin %j",
    (origin) => {
      const problems = problemsOf(() =>
        loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY, HAUNTED_ALLOWED_ORIGINS: origin }, undefined),
      );
      expect(problems).toEqual([expect.stringContaining(`HAUNTED_ALLOWED_ORIGINS`)]);
    },
  );

  it("treats empty TTS instructions as none", () => {
    const c = loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY, HAUNTED_TTS_INSTRUCTIONS: "" }, undefined);
    expect(c.tts.instructions).toBeUndefined();
  });

  it.each([undefined, "", "   "])("names the API key setting when it is %j", (key) => {
    const problems = problemsOf(() => loadConfig({ HAUNTED_OPENROUTER_API_KEY: key }, undefined));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("HAUNTED_OPENROUTER_API_KEY");
  });

  it("lists valid data sources for an unknown data source", () => {
    const problems = problemsOf(() =>
      loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY, HAUNTED_DATA_SOURCE: "kubernetes" }, undefined),
    );
    expect(problems).toEqual(['Unknown data source "kubernetes". Valid data sources: docker, simulator']);
  });

  it("parses numbers strictly and checks ranges", () => {
    const problems = problemsOf(() =>
      loadConfig(
        {
          HAUNTED_OPENROUTER_API_KEY: KEY,
          HAUNTED_POLL_INTERVAL_MS: "5000ms",
          HAUNTED_CPU_THRESHOLD: "1e2",
          HAUNTED_MEMORY_THRESHOLD: "101",
          HAUNTED_DISK_THRESHOLD: "0",
          HAUNTED_PORT: "",
        },
        { monitor: { pollIntervalMs: 999 } },
      ),
    );
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toMatch(/HAUNTED_POLL_INTERVAL_MS must be an integer, got "5000ms"/);
    expect(problems.join("\n")).toMatch(/HAUNTED_CPU_THRESHOLD must be a number/);
    expect(problems.join("\n")).toMatch(/HAUNTED_MEMORY_THRESHOLD .* must be between 1 and 100/);
    expect(problems.join("\n")).toMatch(/HAUNTED_DISK_THRESHOLD .* must be between 1 and 100/);
    expect(problems.join("\n")).toMatch(/HAUNTED_PORT must be an integer/);
  });

  it("rejects an interval below 1000 ms from the file", () => {
    const problems = problemsOf(() =>
      loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY }, { monitor: { pollIntervalMs: 999 } }),
    );
    expect(problems).toEqual([expect.stringMatching(/HAUNTED_POLL_INTERVAL_MS .* must be at least 1000/)]);
  });

  it("collects every problem into one error", () => {
    const problems = problemsOf(() =>
      loadConfig({ HAUNTED_DATA_SOURCE: "nope", HAUNTED_PORT: "abc" }, { thresholds: "high" }),
    );
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain("HAUNTED_OPENROUTER_API_KEY");
    expect(problems.join("\n")).toContain("Valid data sources: docker, simulator");
    expect(problems.join("\n")).toContain('Config file key "thresholds" must be an object');
  });

  it("rejects a config file that is not an object", () => {
    const problems = problemsOf(() => loadConfig({ HAUNTED_OPENROUTER_API_KEY: KEY }, [1, 2]));
    expect(problems).toEqual(["Config file must contain a JSON object"]);
  });
});

describe("toPublicConfig", () => {
  it("excludes the API key, base URL, and Docker endpoint", () => {
    const c = loadConfig(
      { HAUNTED_OPENROUTER_API_KEY: KEY, HAUNTED_OPENROUTER_BASE_URL: "https://proxy.example/api/v1" },
      undefined,
    );
    const pub = toPublicConfig(c);
    expect(pub).toEqual({
      dataSource: "simulator",
      aiGateway: "openrouter",
      llmModel: "openai/gpt-4o-mini",
      ttsModel: "openai/gpt-4o-mini-tts-2025-12-15",
      pollIntervalMs: 5000,
      thresholds: { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 },
    });
    const json = JSON.stringify(pub);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain("proxy.example");
    expect(json).not.toContain(c.docker.endpoint);
  });
});
