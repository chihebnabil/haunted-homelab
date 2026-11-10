import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type {
  ActionProposalDTO,
  AlertSeverity,
  ChatTurn,
  GhostReply,
  HauntingAlert,
  PublicConfig,
  ServerEvent,
  Snapshot,
  StateResponse,
} from "../../shared/types.js";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type ConnectionStatus = "connected" | "disconnected";

/** Per-message voice status. `failed` drives the muted-speaker indicator (Requirement 9.5). */
export type VoiceStatus = "queued" | "playing" | "done" | "failed";

export type ChatEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "ghost"; id: string; reply: GhostReply };

export interface ChatState {
  entries: ChatEntry[];
  /** True while a question waits for the LLM (Requirement 6.6). */
  pending: boolean;
  /** Entry id of the question in flight. */
  pendingEntryId?: string;
  /** Last failed question, kept for resubmission with the persona error text (Requirement 6.7). */
  failed?: { question: string; error: string };
  /** Latest known state of every proposal, by id. Updated by `proposal.updated`. */
  proposals: Record<string, ActionProposalDTO>;
}

export type Popup =
  | {
      kind: "alert";
      /** Popup id; equals the alert id, which is also the speech message id. */
      id: string;
      alertId: string;
      message: string;
      severity: AlertSeverity;
      /** ISO detection time. */
      at: string;
    }
  | {
      kind: "recovery";
      /** Popup id; equals the recovery message id, which is also the speech message id. */
      id: string;
      alertId: string;
      message: string;
      /** ISO resolution time. */
      at: string;
    };

export interface HauntedData {
  connection: ConnectionStatus;
  /** `readAt` of the last received Snapshot (Requirement 10.5). */
  lastSnapshotAt?: string;
  snapshot?: Snapshot;
  /** Active and resolved alerts, oldest first. */
  alerts: HauntingAlert[];
  /** Visible popups, oldest first. */
  popups: Popup[];
  chat: ChatState;
  /** Voice status by speech message id (ghost replies, alert and recovery messages). */
  voiceStatus: Record<string, VoiceStatus>;
  /** Voice output is enabled by default (Requirement 9.3). */
  voiceEnabled: boolean;
  publicConfig?: PublicConfig;
}

export interface HauntedActions {
  setConnection(status: ConnectionStatus): void;
  setPublicConfig(config: PublicConfig): void;
  /** Applies GET /api/state, for the initial load and after reconnects. */
  loadState(state: StateResponse): void;
  applyEvent(event: ServerEvent): void;
  dismissPopup(id: string): void;
  setVoiceEnabled(enabled: boolean): void;
  setVoiceStatus(messageId: string, status: VoiceStatus): void;
  /** Shows the question immediately and sets the waiting flag. Returns the entry id. */
  submitQuestion(question: string): string;
  /** Appends a ghost reply below the question and clears the waiting flag. */
  receiveReply(reply: GhostReply): void;
  /** Removes the in-flight question from the conversation and keeps it for resubmission. */
  failQuestion(question: string, error: string): void;
  clearFailure(): void;
  /** Restores a conversation loaded from sessionStorage. */
  hydrateHistory(turns: readonly ChatTurn[]): void;
}

export type HauntedState = HauntedData & HauntedActions;
export type HauntedStore = StoreApi<HauntedState>;

/** Resolved alerts kept for display; older resolved alerts are dropped first. */
export const MAX_RESOLVED_ALERTS = 100;

export function initialData(): HauntedData {
  return {
    connection: "disconnected",
    alerts: [],
    popups: [],
    chat: { entries: [], pending: false, proposals: {} },
    voiceStatus: {},
    voiceEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

function trimResolved(alerts: HauntingAlert[]): HauntingAlert[] {
  const resolvedCount = alerts.filter((a) => a.status === "resolved").length;
  let excess = resolvedCount - MAX_RESOLVED_ALERTS;
  if (excess <= 0) return alerts;
  return alerts.filter((a) => {
    if (excess > 0 && a.status === "resolved") {
      excess--;
      return false;
    }
    return true;
  });
}

function upsertAlert(alerts: HauntingAlert[], alert: HauntingAlert): HauntingAlert[] {
  const i = alerts.findIndex((a) => a.id === alert.id);
  if (i === -1) return [...alerts, alert];
  const next = alerts.slice();
  next[i] = alert;
  return next;
}

function addPopup(popups: Popup[], popup: Popup): Popup[] {
  return popups.some((p) => p.id === popup.id) ? popups : [...popups, popup];
}

function withProposal(chat: ChatState, proposal: ActionProposalDTO | undefined): ChatState {
  if (!proposal) return chat;
  return { ...chat, proposals: { ...chat.proposals, [proposal.id]: proposal } };
}

function appendReply(chat: ChatState, reply: GhostReply): ChatState {
  const withProp = withProposal(chat, reply.proposal);
  if (chat.entries.some((e) => e.kind === "ghost" && e.id === reply.id)) return withProp;
  return { ...withProp, entries: [...chat.entries, { kind: "ghost", id: reply.id, reply }] };
}

/** Applies one server-to-client event. Pure: returns a new data object. */
export function reduceServerEvent(data: HauntedData, event: ServerEvent): HauntedData {
  switch (event.type) {
    case "snapshot":
      return { ...data, snapshot: event.snapshot, lastSnapshotAt: event.snapshot.readAt };

    case "alert.raised": {
      const { alert, proposal } = event;
      return {
        ...data,
        alerts: trimResolved(upsertAlert(data.alerts, alert)),
        popups: addPopup(data.popups, {
          kind: "alert",
          id: alert.id,
          alertId: alert.id,
          message: alert.message,
          severity: alert.severity,
          at: alert.detectedAt,
        }),
        chat: withProposal(data.chat, proposal),
      };
    }

    case "alert.resolved": {
      const existing = data.alerts.find((a) => a.id === event.alertId);
      const alerts = existing
        ? trimResolved(
            upsertAlert(data.alerts, {
              ...existing,
              status: "resolved",
              resolvedAt: event.resolvedAt,
              recoveryMessage: event.recoveryMessage,
              recoveryMessageId: event.recoveryMessageId,
            }),
          )
        : data.alerts;
      return {
        ...data,
        alerts,
        popups: addPopup(data.popups, {
          kind: "recovery",
          id: event.recoveryMessageId,
          alertId: event.alertId,
          message: event.recoveryMessage,
          at: event.resolvedAt,
        }),
      };
    }

    case "proposal.updated":
      return { ...data, chat: withProposal(data.chat, event.proposal) };

    case "chat.message":
      return { ...data, chat: appendReply(data.chat, event.reply) };
  }
}

/** Applies GET /api/state. Existing popups stay; no popups are created for alerts loaded this way. */
export function reduceLoadState(data: HauntedData, state: StateResponse): HauntedData {
  let chat = data.chat;
  for (const p of state.proposals) chat = withProposal(chat, p);
  return {
    ...data,
    ...(state.snapshot ? { snapshot: state.snapshot, lastSnapshotAt: state.snapshot.readAt } : {}),
    alerts: trimResolved(state.alerts.slice()),
    chat,
  };
}

/** The conversation as chat turns, oldest first. */
export function selectTurns(data: Pick<HauntedData, "chat">): ChatTurn[] {
  return data.chat.entries.map((e) =>
    e.kind === "user" ? { role: "user", text: e.text } : { role: "ghost", text: e.reply.text },
  );
}

/** The last `n` turns, sent as history with each question. */
export function selectRecentTurns(data: Pick<HauntedData, "chat">, n = 10): ChatTurn[] {
  return n > 0 ? selectTurns(data).slice(-n) : [];
}

/** Latest known state of a proposal: the `proposal.updated` value when present, else the given one. */
export function selectProposal(
  data: Pick<HauntedData, "chat">,
  proposal: ActionProposalDTO,
): ActionProposalDTO {
  return data.chat.proposals[proposal.id] ?? proposal;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Creates an independent store. Tests create fresh stores; the app uses `hauntedStore`. */
export function createHauntedStore(initial: Partial<HauntedData> = {}): HauntedStore {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  return createStore<HauntedState>()((set, get) => ({
    ...initialData(),
    ...initial,

    setConnection: (status) => set({ connection: status }),
    setPublicConfig: (config) => set({ publicConfig: config }),
    loadState: (state) => set((s) => reduceLoadState(s, state)),
    applyEvent: (event) => set((s) => reduceServerEvent(s, event)),
    dismissPopup: (id) => set((s) => ({ popups: s.popups.filter((p) => p.id !== id) })),
    setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
    setVoiceStatus: (messageId, status) =>
      set((s) => ({ voiceStatus: { ...s.voiceStatus, [messageId]: status } })),

    submitQuestion: (question) => {
      const id = nextId("user");
      set((s) => {
        const { failed: _failed, ...rest } = s.chat;
        return {
          chat: {
            ...rest,
            entries: [...s.chat.entries, { kind: "user", id, text: question }],
            pending: true,
            pendingEntryId: id,
          },
        };
      });
      return id;
    },

    receiveReply: (reply) =>
      set((s) => {
        const { pendingEntryId: _p, ...rest } = appendReply(s.chat, reply);
        return { chat: { ...rest, pending: false } };
      }),

    failQuestion: (question, error) =>
      set((s) => {
        const { pendingEntryId, ...rest } = s.chat;
        return {
          chat: {
            ...rest,
            entries: s.chat.entries.filter((e) => e.id !== pendingEntryId),
            pending: false,
            failed: { question, error },
          },
        };
      }),

    clearFailure: () =>
      set((s) => {
        const { failed: _failed, ...rest } = s.chat;
        return { chat: rest };
      }),

    hydrateHistory: (turns) => {
      const restored: ChatEntry[] = turns.map((t) => {
        if (t.role === "user") return { kind: "user", id: nextId("user"), text: t.text };
        const id = nextId("history");
        return { kind: "ghost", id, reply: { id, text: t.text, createdAt: "" } };
      });
      const chat = get().chat;
      set({ chat: { ...chat, entries: [...restored, ...chat.entries] } });
    },
  }));
}

/** The application store. */
export const hauntedStore: HauntedStore = createHauntedStore();

/** React hook over `hauntedStore`. */
export function useHaunted<T>(selector: (state: HauntedState) => T): T {
  return useStore(hauntedStore, selector);
}
