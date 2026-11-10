import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../src/web/App.js";
import type { ApiClient } from "../../src/web/api/rest.js";
import type { SocketConnection, SocketOptions } from "../../src/web/api/socket.js";
import { CHAT_HISTORY_KEY } from "../../src/web/state/chatHistory.js";
import { createHauntedStore } from "../../src/web/state/store.js";
import type { HauntingAlert, PublicConfig, StateResponse } from "../../src/shared/types.js";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const config: PublicConfig = {
  dataSource: "simulator",
  aiGateway: "openrouter",
  llmModel: "openai/gpt-4o-mini",
  ttsModel: "openai/gpt-4o-mini-tts-2025-12-15",
  pollIntervalMs: 5000,
  thresholds: { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 },
};

const alert: HauntingAlert = {
  id: "alert-1",
  key: "container_exited:container:plex",
  ruleId: "container_exited",
  subject: { kind: "container", name: "plex" },
  severity: "critical",
  measuredValue: "exited",
  detectedAt: "2025-10-31T23:00:00.000Z",
  message: "The spirit of plex has left its vessel.",
  status: "active",
};

function setup() {
  const store = createHauntedStore();
  let socket: SocketOptions | undefined;
  const getState = vi.fn(async (): Promise<StateResponse> => ({ alerts: [], proposals: [] }));
  const fetchSpeech = vi.fn(async (id: string) => `blob:${id}`);
  const api = {
    getConfig: async () => config,
    getState,
    fetchSpeech,
    listIncidents: async () => [],
  } as unknown as ApiClient;
  const connectSocket = (opts: SocketOptions): SocketConnection => {
    socket = opts;
    return { close: vi.fn(), connected: true };
  };
  const player = { play: vi.fn(() => new Promise<void>(() => {})), stop: vi.fn(), unlock: vi.fn(async () => {}) };
  render(<App store={store} api={api} connectSocket={connectSocket} player={player} />);
  return { store, socket: () => socket!, getState, fetchSpeech };
}

describe("App", () => {
  it("loads config, tracks the connection, and reloads state on every socket open", async () => {
    const { store, socket, getState } = setup();
    await waitFor(() => expect(store.getState().publicConfig).toEqual(config));
    expect(screen.getByRole("contentinfo").textContent).toContain("openai/gpt-4o-mini");

    act(() => socket().onOpen?.());
    expect(store.getState().connection).toBe("connected");
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    act(() => socket().onClose?.());
    expect(store.getState().connection).toBe("disconnected");
  });

  it("speaks raised alerts once while voice is on, and not while voice is off", async () => {
    const { store, socket, fetchSpeech } = setup();
    act(() => socket().onEvent({ type: "alert.raised", alert }));
    act(() => socket().onEvent({ type: "alert.raised", alert }));
    await waitFor(() => expect(fetchSpeech).toHaveBeenCalledTimes(1));
    expect(fetchSpeech.mock.calls[0]![0]).toBe("alert-1");
    expect(screen.getByText(/spirit of plex/)).toBeTruthy();

    act(() => store.getState().setVoiceEnabled(false));
    act(() =>
      socket().onEvent({
        type: "alert.resolved",
        alertId: "alert-1",
        resolvedAt: "2025-10-31T23:01:00.000Z",
        recoveryMessage: "The haunting of plex has lifted.",
        recoveryMessageId: "recovery-1",
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpeech).toHaveBeenCalledTimes(1);
  });

  it("persists chat history to sessionStorage", async () => {
    const { store } = setup();
    act(() => {
      store.getState().submitQuestion("Is plex okay?");
    });
    expect(JSON.parse(sessionStorage.getItem(CHAT_HISTORY_KEY)!)).toEqual([{ role: "user", text: "Is plex okay?" }]);
  });
});
