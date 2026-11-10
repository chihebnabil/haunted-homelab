import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../src/shared/types.js";
import type {
  ActionProposal,
  ActionResult,
} from "../../../src/server/actions/types.js";
import { allowedQuantities, factGuard } from "../../../src/server/agent/factGuard.js";
import { buildFactSheet } from "../../../src/server/agent/factSheet.js";
import {
  actionResultReply,
  chatFailureMessage,
  factTemplateReply,
  noLogsTemplate,
  unknownContainerReply,
} from "../../../src/server/agent/replyTemplates.js";
import { countWords } from "../../../src/shared/words.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const snapshot: Snapshot = {
  readAt: "2025-10-31T23:59:00.000Z",
  containers: [
    { name: "plex", state: "running", cpuPercent: 12.34, memoryBytes: 512 * MiB },
    { name: "pihole", state: "exited", cpuPercent: 0, memoryBytes: 0 },
  ],
  host: {
    cpuPercent: 97.345,
    memoryUsedBytes: 10 * GiB,
    memoryTotalBytes: 32 * GiB,
    filesystems: [{ mount: "/", usedBytes: 97, totalBytes: 100 }],
  },
};

const proposal: ActionProposal = {
  id: "proposal-1",
  action: "restart",
  container: "plex",
  reason: "It exited",
  createdAt: 0,
  status: "confirmed",
  source: "chat",
};

function expectSpokenLimit(text: string): void {
  expect(countWords(text)).toBeLessThanOrEqual(120);
}

describe("unknownContainerReply", () => {
  it("speaks the unknown name and a short list of real containers", () => {
    const reply = unknownContainerReply("ghost-db", ["plex", "pihole"]);

    expect(reply.text).toContain("ghost-db");
    expect(reply.text).toContain("plex");
    expect(reply.text).toContain("pihole");
    expect(reply.list).toBeUndefined();
    expectSpokenLimit(reply.text);
  });

  it("moves a long real-container list out of spoken text", () => {
    const existing = Array.from({ length: 130 }, (_, index) => `container-${index}`);
    const reply = unknownContainerReply("ghost-db", existing);

    expect(reply.text).toContain("ghost-db");
    expect(reply.text).toContain("shown below");
    expect(reply.list).toEqual(existing);
    expectSpokenLimit(reply.text);
  });

  it("truthfully handles a snapshot with no containers", () => {
    const reply = unknownContainerReply("ghost-db", []);

    expect(reply.text).toContain("ghost-db");
    expect(reply.text).toContain("No containers");
    expect(reply.list).toBeUndefined();
    expectSpokenLimit(reply.text);
  });
});

describe("fixed persona templates", () => {
  it("reports that a known container has no logs", () => {
    const reply = noLogsTemplate("homeassistant");

    expect(reply).toContain("homeassistant");
    expect(reply).toContain("No log lines");
    expectSpokenLimit(reply);
  });

  it("returns a generic retryable chat failure without provider details", () => {
    const reply = chatFailureMessage();

    expect(reply).toContain("Try");
    expect(reply).not.toMatch(/OpenRouter|API|endpoint|exception/i);
    expectSpokenLimit(reply);
  });
});

describe("actionResultReply", () => {
  it("names a successful action and container", () => {
    const reply = actionResultReply(proposal, { ok: true });

    expect(reply).toContain("restart");
    expect(reply).toContain("plex");
    expect(reply).toContain("succeeded");
    expectSpokenLimit(reply);
  });

  it("includes a Data_Source error verbatim", () => {
    const result: ActionResult = {
      ok: false,
      error: 'daemon said "no":\ncontainer is locked',
    };
    const reply = actionResultReply({ ...proposal, action: "stop" }, result);

    expect(reply).toContain("stop");
    expect(reply).toContain("plex");
    expect(reply).toContain(result.error);
    expectSpokenLimit(reply);
  });

  it("removes optional prose rather than truncating a long verbatim error", () => {
    const error = Array.from({ length: 115 }, (_, index) => `word${index}`).join(" ");
    const reply = actionResultReply(proposal, { ok: false, error });

    expect(reply).toContain("restart");
    expect(reply).toContain("plex");
    expect(reply).toContain(error);
    expectSpokenLimit(reply);
  });
});

describe("factTemplateReply", () => {
  it("uses exact formatted host and mentioned-container facts", () => {
    const reply = factTemplateReply(snapshot, ["plex", "not-real"]);

    expect(reply).toContain("97.3%");
    expect(reply).toContain("31.3%");
    expect(reply).toContain("10.0 GiB");
    expect(reply).toContain("32.0 GiB");
    expect(reply).toContain("plex is running");
    expect(reply).toContain("12.3%");
    expect(reply).toContain("512.0 MiB");
    expect(reply).not.toContain("not-real");
    expect(factGuard(reply, allowedQuantities(buildFactSheet(snapshot), []))).toEqual({ ok: true });
    expectSpokenLimit(reply);
  });

  it("omits excess container details instead of crossing 120 words", () => {
    const containers = Array.from({ length: 100 }, (_, index) => ({
      name: `service-${index}`,
      state: "running" as const,
      cpuPercent: index / 10,
      memoryBytes: (index + 1) * MiB,
    }));
    const largeSnapshot: Snapshot = { ...snapshot, containers };
    const reply = factTemplateReply(
      largeSnapshot,
      containers.map((container) => container.name),
    );

    expect(factGuard(reply, allowedQuantities(buildFactSheet(largeSnapshot), []))).toEqual({
      ok: true,
    });
    expectSpokenLimit(reply);
  });
});
