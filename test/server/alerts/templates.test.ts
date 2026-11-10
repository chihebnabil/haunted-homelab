import { describe, expect, it } from "vitest";
import {
  acceptAlertText,
  alertTemplate,
  recoveryTemplate,
  subjectLabel,
} from "../../../src/server/alerts/templates.js";
import type { AlertEvent, AlertSubject } from "../../../src/shared/types.js";
import { countWords } from "../../../src/shared/words.js";

function event(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    key: "host_cpu:host:cpu",
    ruleId: "host_cpu",
    subject: { kind: "host", resource: "cpu" },
    severity: "warning",
    measuredValue: "97.3%",
    detectedAt: "2025-10-31T23:00:00.000Z",
    ...overrides,
  };
}

describe("subjectLabel", () => {
  it.each<[AlertSubject, string]>([
    [{ kind: "host", resource: "cpu" }, "host CPU"],
    [{ kind: "host", resource: "memory" }, "host memory"],
    [{ kind: "filesystem", mount: "/" }, "filesystem /"],
    [{ kind: "filesystem", mount: "/mnt/media" }, "filesystem /mnt/media"],
    [{ kind: "container", name: "Nginx-Proxy_1" }, "Nginx-Proxy_1"],
    [{ kind: "data_source" }, "data source"],
  ])("formats %j as %s", (subject, expected) => {
    expect(subjectLabel(subject)).toBe(expected);
  });
});

describe("alertTemplate", () => {
  it("uses the specified host CPU template", () => {
    expect(alertTemplate(event())).toBe(
      "A strange process is haunting the CPU. The host CPU burns at 97.3% and will not rest.",
    );
  });

  it("uses the specified exited-container template", () => {
    expect(
      alertTemplate(
        event({
          key: "container_exited:container:plex",
          ruleId: "container_exited",
          subject: { kind: "container", name: "plex" },
          severity: "critical",
          measuredValue: "exited",
        }),
      ),
    ).toBe("The spirit of plex has left its vessel. It now lies exited in the dark.");
  });

  it.each<AlertEvent>([
    event({ ruleId: "host_memory", subject: { kind: "host", resource: "memory" }, measuredValue: "94.8%" }),
    event({ ruleId: "disk", subject: { kind: "filesystem", mount: "/mnt/media" }, measuredValue: "97.0%" }),
    event({ ruleId: "container_restarting", subject: { kind: "container", name: "pihole" }, measuredValue: "restarting" }),
    event({ ruleId: "new_container_cpu", subject: { kind: "container", name: "unknown-process-x13" }, measuredValue: "98.1%" }),
    event({ ruleId: "data_source_unavailable", subject: { kind: "data_source" }, measuredValue: "connection refused" }),
  ])("keeps the subject and measured value verbatim for $ruleId", (alert) => {
    const message = alertTemplate(alert);
    expect(message).toContain(subjectLabel(alert.subject));
    expect(message).toContain(alert.measuredValue);
    expect(countWords(message)).toBeLessThanOrEqual(40);
  });

  it("drops decorative wording rather than truncating a long measured value", () => {
    const measuredValue = Array.from({ length: 35 }, (_, index) => `detail-${index}`).join(" ");
    const alert = event({ measuredValue });
    const message = alertTemplate(alert);

    expect(message).toBe(`host CPU: ${measuredValue}`);
    expect(countWords(message)).toBeLessThanOrEqual(40);
  });
});

describe("recoveryTemplate", () => {
  it("uses the specified recovery template", () => {
    expect(recoveryTemplate(event())).toBe(
      "The haunting of host CPU has lifted. The machine breathes easy again.",
    );
  });

  it("preserves dynamic subject labels verbatim", () => {
    const alert = event({ subject: { kind: "container", name: "Nginx-Proxy_1" } });
    expect(recoveryTemplate(alert)).toContain("Nginx-Proxy_1");
  });
});

describe("acceptAlertText", () => {
  it("accepts text containing the exact subject and measured value within 40 words", () => {
    expect(acceptAlertText("The host CPU shivers at 97.3%.", event())).toBe(true);
  });

  it("accepts exactly 40 whitespace-separated words", () => {
    const candidate = ["host", "CPU", "97.3%", ...Array.from({ length: 37 }, () => "echo")].join(" ");
    expect(countWords(candidate)).toBe(40);
    expect(acceptAlertText(candidate, event())).toBe(true);
  });

  it("rejects 41 words", () => {
    const candidate = ["host", "CPU", "97.3%", ...Array.from({ length: 38 }, () => "echo")].join(" ");
    expect(countWords(candidate)).toBe(41);
    expect(acceptAlertText(candidate, event())).toBe(false);
  });

  it("rejects a missing or altered subject label", () => {
    expect(acceptAlertText("The CPU shivers at 97.3%.", event())).toBe(false);
    expect(acceptAlertText("The Host CPU shivers at 97.3%.", event())).toBe(false);
  });

  it("rejects a missing or reformatted measured value", () => {
    expect(acceptAlertText("The host CPU shivers.", event())).toBe(false);
    expect(acceptAlertText("The host CPU shivers at 97.30%.", event())).toBe(false);
    expect(acceptAlertText("The host CPU shivers at 97.3 %.", event())).toBe(false);
  });

  it("uses the shared whitespace word-counting rules", () => {
    expect(acceptAlertText("The\thost CPU\nshivers at\n97.3%.", event())).toBe(true);
  });
});
