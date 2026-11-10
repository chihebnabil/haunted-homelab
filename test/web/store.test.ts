import { describe, expect, it } from "vitest";
import type {
  ActionProposalDTO,
  GhostReply,
  HauntingAlert,
  ServerEvent,
  Snapshot,
} from "../../src/shared/types.js";
import {
  MAX_RESOLVED_ALERTS,
  createHauntedStore,
  selectProposal,
  selectRecentTurns,
  selectTurns,
} from "../../src/web/state/store.js";

const snapshot: Snapshot = {
  readAt: "2025-10-31T00:00:05.000Z",
  containers: [{ name: "plex", state: "running", cpuPercent: 12, memoryBytes: 500 * 1024 * 1024 }],
  host: { cpuPercent: 20, memoryUsedBytes: 8, memoryTotalBytes: 32, filesystems: [] },
};

function alert(id: string, overrides: Partial<HauntingAlert> = {}): HauntingAlert {
  return {
    id,
    key: `container_exited:container:${id}`,
    ruleId: "container_exited",
    subject: { kind: "container", name: id },
    severity: "critical",
    measuredValue: "exited",
    detectedAt: "2025-10-31T00:00:10.000Z",
    message: `The spirit of ${id} has left its vessel.`,
    status: "active",
    ...overrides,
  };
}

function proposal(id: string, status: ActionProposalDTO["status"] = "pending"): ActionProposalDTO {
  return {
    id,
    action: "restart",
    container: "plex",
    reason: "plex exited",
    createdAt: "2025-10-31T00:00:10.000Z",
    expiresAt: "2025-10-31T00:05:10.000Z",
    status,
  };
}

function reply(id: string, text = "The ghost speaks.", extra: Partial<GhostReply> = {}): GhostReply {
  return { id, text, createdAt: "2025-10-31T00:00:11.000Z", ...extra };
}

describe("store defaults", () => {
  it("starts disconnected with voice enabled and empty chat", () => {
    const s = createHauntedStore().getState();
    expect(s.connection).toBe("disconnected");
    expect(s.voiceEnabled).toBe(true);
    expect(s.chat.entries).toEqual([]);
    expect(s.chat.pending).toBe(false);
    expect(s.popups).toEqual([]);
  });
});

describe("server events", () => {
  it("snapshot replaces the snapshot and records lastSnapshotAt", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "snapshot", snapshot });
    expect(store.getState().snapshot).toEqual(snapshot);
    expect(store.getState().lastSnapshotAt).toBe(snapshot.readAt);
  });

  it("disconnecting keeps the last snapshot time", () => {
    const store = createHauntedStore();
    store.getState().setConnection("connected");
    store.getState().applyEvent({ type: "snapshot", snapshot });
    store.getState().setConnection("disconnected");
    expect(store.getState().connection).toBe("disconnected");
    expect(store.getState().lastSnapshotAt).toBe(snapshot.readAt);
  });

  it("alert.raised adds the alert, one popup, and the proposal", () => {
    const store = createHauntedStore();
    const event: ServerEvent = { type: "alert.raised", alert: alert("a1"), proposal: proposal("p1") };
    store.getState().applyEvent(event);
    store.getState().applyEvent(event); // duplicate delivery
    const s = store.getState();
    expect(s.alerts).toHaveLength(1);
    expect(s.popups).toEqual([
      {
        kind: "alert",
        id: "a1",
        alertId: "a1",
        message: alert("a1").message,
        severity: "critical",
        at: "2025-10-31T00:00:10.000Z",
      },
    ]);
    expect(s.chat.proposals.p1).toEqual(proposal("p1"));
  });

  it("alert.resolved marks the alert resolved and adds a recovery popup", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "alert.raised", alert: alert("a1") });
    store.getState().applyEvent({
      type: "alert.resolved",
      alertId: "a1",
      resolvedAt: "2025-10-31T00:01:00.000Z",
      recoveryMessage: "The haunting of plex has lifted.",
      recoveryMessageId: "r1",
    });
    const s = store.getState();
    expect(s.alerts[0]).toMatchObject({
      status: "resolved",
      resolvedAt: "2025-10-31T00:01:00.000Z",
      recoveryMessageId: "r1",
      recoveryMessage: "The haunting of plex has lifted.",
    });
    expect(s.popups.map((p) => [p.kind, p.id])).toEqual([
      ["alert", "a1"],
      ["recovery", "r1"],
    ]);
  });

  it("keeps at most MAX_RESOLVED_ALERTS resolved alerts, dropping the oldest", () => {
    const store = createHauntedStore();
    const total = MAX_RESOLVED_ALERTS + 5;
    for (let i = 0; i < total; i++) {
      store.getState().applyEvent({ type: "alert.raised", alert: alert(`a${i}`, { status: "resolved" }) });
    }
    store.getState().applyEvent({ type: "alert.raised", alert: alert("live") });
    const ids = store.getState().alerts.map((a) => a.id);
    expect(ids).toHaveLength(MAX_RESOLVED_ALERTS + 1);
    expect(ids[0]).toBe("a5");
    expect(ids).toContain("live");
  });

  it("proposal.updated replaces the known proposal state", () => {
    const store = createHauntedStore();
    store.getState().receiveReply(reply("g1", "Shall I restart plex?", { proposal: proposal("p1") }));
    store.getState().applyEvent({ type: "proposal.updated", proposal: proposal("p1", "confirmed") });
    const s = store.getState();
    expect(selectProposal(s, proposal("p1")).status).toBe("confirmed");
  });

  it("chat.message appends a reply once even if it was already received over HTTP", () => {
    const store = createHauntedStore();
    store.getState().receiveReply(reply("g1"));
    store.getState().applyEvent({ type: "chat.message", reply: reply("g1") });
    store.getState().applyEvent({ type: "chat.message", reply: reply("g2", "Restarted.") });
    expect(store.getState().chat.entries.map((e) => e.id)).toEqual(["g1", "g2"]);
  });
});

describe("popups and voice", () => {
  it("dismissPopup removes only that popup", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "alert.raised", alert: alert("a1") });
    store.getState().applyEvent({ type: "alert.raised", alert: alert("a2") });
    store.getState().dismissPopup("a1");
    expect(store.getState().popups.map((p) => p.id)).toEqual(["a2"]);
  });

  it("tracks voice status per message and the voice toggle", () => {
    const store = createHauntedStore();
    store.getState().setVoiceStatus("g1", "failed");
    store.getState().setVoiceEnabled(false);
    expect(store.getState().voiceStatus).toEqual({ g1: "failed" });
    expect(store.getState().voiceEnabled).toBe(false);
  });
});

describe("chat flow", () => {
  it("shows the question at once, waits, then appends the reply below it", () => {
    const store = createHauntedStore();
    store.getState().submitQuestion("Is plex okay?");
    expect(store.getState().chat.pending).toBe(true);
    expect(selectTurns(store.getState())).toEqual([{ role: "user", text: "Is plex okay?" }]);
    store.getState().receiveReply(reply("g1", "plex is running at 12.0%."));
    expect(store.getState().chat.pending).toBe(false);
    expect(selectTurns(store.getState())).toEqual([
      { role: "user", text: "Is plex okay?" },
      { role: "ghost", text: "plex is running at 12.0%." },
    ]);
  });

  it("a failure removes the in-flight question and keeps it for resubmission", () => {
    const store = createHauntedStore();
    store.getState().submitQuestion("first");
    store.getState().receiveReply(reply("g1"));
    store.getState().submitQuestion("second");
    store.getState().failQuestion("second", "The reply was lost in the void.");
    const chat = store.getState().chat;
    expect(chat.pending).toBe(false);
    expect(chat.failed).toEqual({ question: "second", error: "The reply was lost in the void." });
    expect(selectTurns(store.getState()).map((t) => t.text)).toEqual(["first", "The ghost speaks."]);

    store.getState().submitQuestion("second");
    expect(store.getState().chat.failed).toBeUndefined();
  });

  it("selectRecentTurns returns the last 10 turns", () => {
    const store = createHauntedStore();
    for (let i = 0; i < 7; i++) {
      store.getState().submitQuestion(`q${i}`);
      store.getState().receiveReply(reply(`g${i}`, `a${i}`));
    }
    const recent = selectRecentTurns(store.getState());
    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({ role: "user", text: "q2" });
    expect(recent[9]).toEqual({ role: "ghost", text: "a6" });
  });

  it("hydrateHistory restores saved turns before new entries", () => {
    const store = createHauntedStore();
    store.getState().hydrateHistory([
      { role: "user", text: "hello" },
      { role: "ghost", text: "boo" },
    ]);
    expect(selectTurns(store.getState())).toEqual([
      { role: "user", text: "hello" },
      { role: "ghost", text: "boo" },
    ]);
  });
});

describe("loadState", () => {
  it("applies snapshot, alerts, and proposals without creating popups", () => {
    const store = createHauntedStore();
    store.getState().loadState({ snapshot, alerts: [alert("a1")], proposals: [proposal("p1", "expired")] });
    const s = store.getState();
    expect(s.lastSnapshotAt).toBe(snapshot.readAt);
    expect(s.alerts.map((a) => a.id)).toEqual(["a1"]);
    expect(s.chat.proposals.p1?.status).toBe("expired");
    expect(s.popups).toEqual([]);
  });
});
