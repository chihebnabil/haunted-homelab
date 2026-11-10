import { describe, expect, it } from "vitest";
import { classifyLine, extractLogEvents } from "../../../src/server/agent/logEvents.js";
import {
  GENERIC_LOG_TEMPLATES,
  SERVICE_LOG_TEMPLATES,
  defaultLinesForTick,
} from "../../../src/server/datasource/simulator/logs.js";
import type { LogLine } from "../../../src/shared/types.js";

describe("classifyLine", () => {
  it("classifies error keywords", () => {
    for (const text of [
      "ERROR: startup failed: could not bind to port 32400, retrying",
      "FATAL: unhandled exception in worker thread: segmentation fault",
      "CRITICAL disk failure",
      "goroutine panic: nil map",
      "Unhandled exception in handler",
      "request failed after 3 tries",
      "err=connection reset",
      "[crit] worker crashed",
      "error_code=42",
    ]) {
      expect(classifyLine(text), text).toBe("error");
    }
  });

  it("classifies warning keywords", () => {
    expect(classifyLine("WARN: Slow transcode")).toBe("warning");
    expect(classifyLine("WARNING (MainThread) device slow")).toBe("warning");
    expect(classifyLine("[warn] an upstream response is buffered")).toBe("warning");
  });

  it("lets error win over warning", () => {
    expect(classifyLine("WARN: retry failed")).toBe("error");
    expect(classifyLine("warning: ERROR in config")).toBe("error");
  });

  it("ignores keywords embedded in other words", () => {
    expect(classifyLine("terrorist movie night")).toBeNull();
    expect(classifyLine("forewarned is forearmed")).toBeNull();
    expect(classifyLine("NullPointerException thrown")).toBeNull();
    expect(classifyLine("all systems nominal")).toBeNull();
    expect(classifyLine("")).toBeNull();
  });

  it("never labels simulator default log lines as errors", () => {
    const names = [...Object.keys(SERVICE_LOG_TEMPLATES), "unknown-process-x13"];
    expect(GENERIC_LOG_TEMPLATES.length).toBeGreaterThan(0);
    for (const name of names) {
      for (let tick = 0; tick < 300; tick++) {
        for (const line of defaultLinesForTick(1337, name, tick)) {
          expect(classifyLine(line.text), line.text).not.toBe("error");
        }
      }
    }
  });
});

describe("extractLogEvents", () => {
  it("returns error and warning lines in log order with timestamps", () => {
    const lines: LogLine[] = [
      { timestamp: "2025-10-31T00:00:00.000Z", text: "Transcoder session started" },
      { timestamp: "2025-10-31T00:00:01.000Z", text: "WARN: Slow transcode", stream: "stdout" },
      { timestamp: "2025-10-31T00:00:02.000Z", text: "terrorist detected in title" },
      { timestamp: "2025-10-31T00:00:03.000Z", text: "FATAL: segmentation fault", stream: "stderr" },
    ];
    expect(extractLogEvents(lines)).toEqual([
      { timestamp: "2025-10-31T00:00:01.000Z", level: "warning", text: "WARN: Slow transcode" },
      { timestamp: "2025-10-31T00:00:03.000Z", level: "error", text: "FATAL: segmentation fault" },
    ]);
  });

  it("returns an empty list for no lines", () => {
    expect(extractLogEvents([])).toEqual([]);
  });
});
