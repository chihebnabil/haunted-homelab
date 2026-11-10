import { describe, expect, it } from "vitest";
import {
  PROPOSAL_TTL_MS,
  ProposalStore,
  cancel,
  confirm,
  createProposal,
  initialProposalState,
  toProposalDTO,
} from "../../../src/server/actions/ProposalStore.js";
import { DataSourceActionError, type DataSource } from "../../../src/server/datasource/types.js";
import type { HostMetrics } from "../../../src/shared/types.js";

/** In-memory data source that records actions; `gate` lets a test hold an action open. */
class RecordingSource implements DataSource {
  readonly kind = "simulator" as const;
  readonly calls: string[] = [];
  failWith: unknown;
  gate: Promise<void> | undefined;

  async listContainers() {
    return [];
  }
  async readLogs() {
    return [];
  }
  async readHostMetrics(): Promise<HostMetrics> {
    return { cpuPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, filesystems: [] };
  }
  async restart(name: string) {
    await this.#act(`restart:${name}`);
  }
  async stop(name: string) {
    await this.#act(`stop:${name}`);
  }
  async #act(call: string) {
    this.calls.push(call);
    if (this.gate !== undefined) await this.gate;
    if (this.failWith !== undefined) throw this.failWith;
  }
}

const T0 = Date.UTC(2025, 9, 31, 23, 0, 0);

function setup() {
  const ds = new RecordingSource();
  let now = T0;
  let n = 0;
  const store = new ProposalStore({ ds, clock: { now: () => now }, newId: () => `p${++n}` });
  return { ds, store, advance: (ms: number) => (now += ms) };
}

describe("pure proposal transitions", () => {
  const base = { id: "a", action: "restart", container: "plex", reason: "exited", createdAt: T0, source: "chat" } as const;

  it("createProposal adds a pending proposal and rejects duplicate ids", () => {
    const s = createProposal(initialProposalState(), base);
    expect(s.proposals.get("a")?.status).toBe("pending");
    expect(() => createProposal(s, base)).toThrow(/Duplicate/);
  });

  it("confirm does not mutate the input state", () => {
    const s = createProposal(initialProposalState(), base);
    const { state } = confirm(s, "a", T0);
    expect(s.proposals.get("a")?.status).toBe("pending");
    expect(state.proposals.get("a")?.status).toBe("confirmed");
  });

  it("confirm at exactly the TTL executes; one ms later expires", () => {
    const s = createProposal(initialProposalState(), base);
    expect(confirm(s, "a", T0 + PROPOSAL_TTL_MS).decision.kind).toBe("execute");
    const late = confirm(s, "a", T0 + PROPOSAL_TTL_MS + 1);
    expect(late.decision).toMatchObject({ kind: "rejected", reason: "expired" });
    expect(late.state.proposals.get("a")?.status).toBe("expired");
    expect(confirm(late.state, "a", T0).decision).toMatchObject({ kind: "rejected", reason: "already_expired" });
  });

  it("cancel moves only pending proposals", () => {
    const s = createProposal(initialProposalState(), base);
    const c = cancel(s, "a");
    expect(c.decision.ok).toBe(true);
    expect(cancel(c.state, "a").decision).toMatchObject({ ok: false, reason: "already_cancelled" });
    expect(cancel(s, "missing").decision).toEqual({ ok: false, reason: "not_found" });
  });

  it("toProposalDTO uses ISO times and createdAt + 5 minutes", () => {
    const dto = toProposalDTO({ ...base, status: "pending" });
    expect(dto).toEqual({
      id: "a",
      action: "restart",
      container: "plex",
      reason: "exited",
      createdAt: "2025-10-31T23:00:00.000Z",
      expiresAt: "2025-10-31T23:05:00.000Z",
      status: "pending",
    });
    expect(dto).not.toHaveProperty("source");
  });
});

describe("ProposalStore", () => {
  it("create returns a pending DTO and list/get reflect it", () => {
    const { store } = setup();
    const dto = store.create({ action: "stop", container: "unknown-process-x13", reason: "hot", source: "alert" });
    expect(dto).toMatchObject({ id: "p1", status: "pending", action: "stop" });
    expect(store.get("p1")).toEqual(dto);
    expect(store.list()).toEqual([dto]);
    expect(store.get("nope")).toBeUndefined();
  });

  it("confirm runs the action once and rejects later confirms and cancels", async () => {
    const { ds, store } = setup();
    store.create({ action: "restart", container: "plex", reason: "exited", source: "chat" });

    const first = await store.confirm("p1");
    expect(first).toMatchObject({ kind: "executed", result: { ok: true }, dto: { status: "confirmed" } });
    expect(await store.confirm("p1")).toMatchObject({ kind: "rejected", reason: "already_confirmed" });
    expect(store.cancel("p1")).toMatchObject({ ok: false, reason: "already_confirmed" });
    expect(ds.calls).toEqual(["restart:plex"]);
  });

  it("two concurrent confirms run the action at most once", async () => {
    const { ds, store } = setup();
    let release!: () => void;
    ds.gate = new Promise<void>((r) => (release = r));
    store.create({ action: "stop", container: "pihole", reason: "x", source: "chat" });

    const a = store.confirm("p1");
    const b = store.confirm("p1");
    expect(await b).toMatchObject({ kind: "rejected", reason: "already_confirmed" });
    release();
    expect(await a).toMatchObject({ kind: "executed" });
    expect(ds.calls).toEqual(["stop:pihole"]);
  });

  it("expired confirm does not run the action and marks the proposal expired", async () => {
    const { ds, store, advance } = setup();
    store.create({ action: "restart", container: "plex", reason: "x", source: "chat" });
    advance(PROPOSAL_TTL_MS + 1);
    expect(await store.confirm("p1")).toMatchObject({ kind: "rejected", reason: "expired", dto: { status: "expired" } });
    expect(store.get("p1")?.status).toBe("expired");
    expect(ds.calls).toEqual([]);
  });

  it("cancel prevents execution; unknown ids are not_found", async () => {
    const { ds, store } = setup();
    store.create({ action: "restart", container: "plex", reason: "x", source: "chat" });
    expect(store.cancel("p1")).toMatchObject({ ok: true, dto: { status: "cancelled" } });
    expect(await store.confirm("p1")).toMatchObject({ kind: "rejected", reason: "already_cancelled" });
    expect(await store.confirm("zzz")).toEqual({ kind: "rejected", reason: "not_found" });
    expect(store.cancel("zzz")).toEqual({ ok: false, reason: "not_found" });
    expect(ds.calls).toEqual([]);
  });

  it("reports the Data_Source error and keeps the proposal confirmed", async () => {
    const { ds, store } = setup();
    ds.failWith = new DataSourceActionError("container is paused");
    store.create({ action: "restart", container: "plex", reason: "x", source: "chat" });
    expect(await store.confirm("p1")).toMatchObject({
      kind: "executed",
      result: { ok: false, error: "container is paused" },
    });
    expect(store.get("p1")?.status).toBe("confirmed");
  });
});
