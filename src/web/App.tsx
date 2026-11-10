import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { GhostReply, ServerEvent } from "../shared/types.js";
import { api as defaultApi, type ApiClient } from "./api/rest.js";
import {
  connectSocket as defaultConnectSocket,
  type SocketConnection,
  type SocketOptions,
} from "./api/socket.js";
import { AudioQueue, HtmlAudioPlayer, type Player } from "./audio/AudioQueue.js";
import { AlertPopupStack } from "./components/AlertPopupStack.js";
import { ChatPage } from "./components/ChatPage.js";
import { IncidentControl } from "./components/IncidentControl.js";
import { PrivacyNotice } from "./components/PrivacyNotice.js";
import { StatusPanel } from "./components/StatusPanel.js";
import { VoiceToggle } from "./components/VoiceToggle.js";
import { loadHistory, saveHistory } from "./state/chatHistory.js";
import {
  hauntedStore,
  selectTurns,
  type HauntedStore,
} from "./state/store.js";
import "./app.css";

export interface AppProps {
  store?: HauntedStore;
  api?: ApiClient;
  connectSocket?: (options: SocketOptions) => SocketConnection;
  /** Defaults to an `HtmlAudioPlayer`; tests pass a fake. */
  player?: Player & { unlock(): Promise<void> };
}

function spokenMessageId(event: ServerEvent): string | undefined {
  switch (event.type) {
    case "alert.raised":
      return event.alert.id;
    case "alert.resolved":
      return event.recoveryMessageId;
    case "chat.message":
      return event.reply.id;
    case "snapshot":
    case "proposal.updated":
      return undefined;
  }
}

/** Root Web_App wiring for REST, WebSocket events, speech, and session history. */
export function App({
  store = hauntedStore,
  api = defaultApi,
  connectSocket = defaultConnectSocket,
  player: suppliedPlayer,
}: AppProps) {
  const voiceEnabled = useStore(store, (state) => state.voiceEnabled);
  const [startupError, setStartupError] = useState<string>();
  const player = useMemo(() => suppliedPlayer ?? new HtmlAudioPlayer(), [suppliedPlayer]);
  const spokenIds = useRef(new Set<string>());
  // StrictMode runs mount effects twice in development; hydrate history only once.
  const hydrated = useRef(false);

  const queue = useMemo(
    () =>
      new AudioQueue(
        player,
        (messageId, signal) => api.fetchSpeech(messageId, signal),
        (messageId) => store.getState().setVoiceStatus(messageId, "failed"),
      ),
    [api, player, store],
  );

  const enqueueSpeech = (messageId: string): void => {
    if (!store.getState().voiceEnabled || spokenIds.current.has(messageId)) return;
    spokenIds.current.add(messageId);
    store.getState().setVoiceStatus(messageId, "queued");
    queue.enqueue(messageId);
  };

  const receiveReply = (reply: GhostReply): void => enqueueSpeech(reply.id);

  useEffect(() => {
    if (!voiceEnabled) queue.clear();
  }, [queue, voiceEnabled]);

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      store.getState().hydrateHistory(loadHistory());
    }
    const unsubscribeHistory = store.subscribe((state, previous) => {
      if (state.chat.entries !== previous.chat.entries) saveHistory(selectTurns(state));
    });

    let disposed = false;
    const loadPublicState = async (): Promise<void> => {
      try {
        const [config, state] = await Promise.all([api.getConfig(), api.getState()]);
        if (disposed) return;
        store.getState().setPublicConfig(config);
        store.getState().loadState(state);
        setStartupError(undefined);
      } catch {
        if (!disposed) setStartupError("The backend is silent. Waiting for its signal…");
      }
    };
    const reloadState = async (): Promise<void> => {
      try {
        const state = await api.getState();
        if (!disposed) store.getState().loadState(state);
      } catch {
        // The socket close callback owns connection status; retry on the next open.
      }
    };

    void loadPublicState();
    const socket = connectSocket({
      onEvent: (event) => {
        store.getState().applyEvent(event);
        const id = spokenMessageId(event);
        if (id !== undefined) enqueueSpeech(id);
      },
      onOpen: () => {
        store.getState().setConnection("connected");
        void reloadState();
      },
      onClose: () => store.getState().setConnection("disconnected"),
    });

    return () => {
      disposed = true;
      socket.close();
      unsubscribeHistory();
      queue.clear();
    };
  }, [api, connectSocket, queue, store]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-kicker">A presence watches the rack</p>
          <h1>Haunted Homelab</h1>
        </div>
        <VoiceToggle store={store} onUnlock={() => player.unlock()} />
      </header>

      {startupError && (
        <p className="app-startup-error" role="status">
          {startupError}
        </p>
      )}

      <main className="app-main">
        <div className="app-dashboard">
          <StatusPanel store={store} />
          <IncidentControl store={store} api={api} />
        </div>
        <ChatPage store={store} api={api} onReply={receiveReply} />
      </main>

      <AlertPopupStack store={store} />
      <PrivacyNotice store={store} />
    </div>
  );
}

export default App;
