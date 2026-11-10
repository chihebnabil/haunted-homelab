import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ActionProposalDTO,
  CancelProposalResponse,
  ChatRequest,
  ConfirmProposalResponse,
  GhostReply,
} from "../../src/shared/types.js";
import { ApiError, type ApiClient } from "../../src/web/api/rest.js";
import { createHauntedStore } from "../../src/web/state/store.js";
import { ChatPage, DEFAULT_CHAT_ERROR, VOICE_FAILED_TEXT } from "../../src/web/components/ChatPage.js";
import { ProposalCard } from "../../src/web/components/ProposalCard.js";

afterEach(cleanup);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function unused(): never {
  throw new Error("not used in this test");
}

function makeApi(overrides: Partial<ApiClient>): ApiClient {
  return {
    getConfig: unused,
    getState: unused,
    chat: unused,
    confirmProposal: unused,
    cancelProposal: unused,
    listIncidents: unused,
    stageIncident: unused,
    clearIncidents: unused,
    fetchSpeech: unused,
    ...overrides,
  };
}

function proposal(over: Partial<ActionProposalDTO> = {}): ActionProposalDTO {
  return {
    id: "p1",
    action: "restart",
    container: "plex",
    reason: "plex has exited",
    createdAt: "2024-01-01T00:00:00.000Z",
    expiresAt: "2024-01-01T00:05:00.000Z",
    status: "pending",
    ...over,
  };
}

function ask(text: string) {
  fireEvent.change(screen.getByLabelText("Ask the ghost"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("ChatPage", () => {
  it("shows the question at once, a waiting indicator, then the reply below the question", async () => {
    const store = createHauntedStore();
    store.getState().hydrateHistory([
      { role: "user", text: "earlier" },
      { role: "ghost", text: "earlier answer" },
    ]);
    const pendingChat = deferred<GhostReply>();
    const chat = vi.fn((_req: ChatRequest) => pendingChat.promise);
    const onReply = vi.fn();
    render(<ChatPage store={store} api={makeApi({ chat })} onReply={onReply} />);

    ask("Summarize the plex logs");

    const questions = screen.getAllByTestId("user-question");
    expect(questions[questions.length - 1]!.textContent).toBe("Summarize the plex logs");
    expect(screen.getByText(/ghost is stirring/)).toBeTruthy();
    expect(chat).toHaveBeenCalledWith({
      question: "Summarize the plex logs",
      history: [
        { role: "user", text: "earlier" },
        { role: "ghost", text: "earlier answer" },
      ],
    });

    const reply: GhostReply = {
      id: "r1",
      text: "The plex spirit groans.",
      createdAt: "2024-01-01T00:00:10.000Z",
      events: [{ timestamp: "2024-01-01T00:00:01.000Z", level: "error", text: "FATAL: crash" }],
      list: ["plex", "pihole"],
    };
    await act(async () => pendingChat.resolve(reply));

    expect(screen.queryByText(/ghost is stirring/)).toBeNull();
    const items = Array.from(document.querySelectorAll(".chat-page__entries > li"));
    expect(items.map((li) => li.getAttribute("data-testid"))).toEqual([
      "user-question",
      "ghost-reply",
      "user-question",
      "ghost-reply",
    ]);
    expect(items[3]!.textContent).toContain("The plex spirit groans.");
    const eventTime = screen.getByLabelText("Log events").querySelector("time");
    expect(eventTime?.getAttribute("dateTime")).toBe("2024-01-01T00:00:01.000Z");
    expect(screen.getByLabelText("Log events").textContent).toContain("FATAL: crash");
    expect(screen.getByLabelText("Names").textContent).toBe("plexpihole");
    expect(onReply).toHaveBeenCalledWith(reply);
  });

  it("shows the persona error, restores the question, and retries", async () => {
    const store = createHauntedStore();
    const first = deferred<GhostReply>();
    const second = deferred<GhostReply>();
    const chat = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<ChatPage store={store} api={makeApi({ chat })} />);

    ask("Is plex okay?");
    await act(async () =>
      first.reject(new ApiError("http", 504, { error: "The spirits timed out." }, "timeout")),
    );

    expect(screen.getByRole("alert").textContent).toContain("The spirits timed out.");
    expect((screen.getByLabelText("Ask the ghost") as HTMLInputElement).value).toBe("Is plex okay?");
    expect(screen.queryAllByTestId("user-question")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]![0]).toEqual({ question: "Is plex okay?", history: [] });
    await act(async () => second.resolve({ id: "r2", text: "plex is running.", createdAt: "" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("ghost-reply").textContent).toContain("plex is running.");
  });

  it("uses a default persona error when the failure has no error text", async () => {
    const store = createHauntedStore();
    const chat = vi.fn().mockRejectedValue(new ApiError("network", 0, undefined, "down"));
    render(<ChatPage store={store} api={makeApi({ chat })} />);

    await act(async () => ask("hello"));

    expect(screen.getByRole("alert").textContent).toContain(DEFAULT_CHAT_ERROR);
  });

  it("shows the muted-speaker indicator when voice failed for a reply", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "chat.message", reply: { id: "r1", text: "boo", createdAt: "" } });
    render(<ChatPage store={store} api={makeApi({})} />);
    expect(screen.queryByText(VOICE_FAILED_TEXT)).toBeNull();

    act(() => store.getState().setVoiceStatus("r1", "failed"));

    expect(screen.getByText(VOICE_FAILED_TEXT)).toBeTruthy();
  });
});

describe("ProposalCard", () => {
  it("disables both controls and shows Cancelled after cancel", async () => {
    const store = createHauntedStore();
    const p = proposal();
    const cancelProposal = vi.fn(
      async (): Promise<CancelProposalResponse> => ({ proposal: { ...p, status: "cancelled" } }),
    );
    render(<ProposalCard proposal={p} store={store} api={makeApi({ cancelProposal })} />);

    const confirmBtn = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    const cancelBtn = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);

    await act(async () => fireEvent.click(cancelBtn));

    expect(cancelProposal).toHaveBeenCalledWith("p1");
    expect(confirmBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Cancelled");
  });

  it("shows Expired when the confirm is rejected as expired", async () => {
    const store = createHauntedStore();
    const p = proposal();
    const confirmProposal = vi.fn(async (): Promise<ConfirmProposalResponse> => {
      throw new ApiError("http", 409, { proposal: { ...p, status: "expired" }, reason: "expired" }, "409");
    });
    render(<ProposalCard proposal={p} store={store} api={makeApi({ confirmProposal })} />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm" })));

    expect(screen.getByRole("status").textContent).toBe("Expired");
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("appends the action result reply and shows Confirmed after confirm", async () => {
    const store = createHauntedStore();
    const p = proposal();
    const reply: GhostReply = { id: "r9", text: "plex rises again.", createdAt: "" };
    const confirmProposal = vi.fn(
      async (): Promise<ConfirmProposalResponse> => ({ proposal: { ...p, status: "confirmed" }, reply }),
    );
    const onReply = vi.fn();
    store.getState().applyEvent({ type: "chat.message", reply: { id: "r1", text: "Restart?", proposal: p, createdAt: "" } });
    render(<ChatPage store={store} api={makeApi({ confirmProposal })} onReply={onReply} />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm" })));

    expect(screen.getByRole("status").textContent).toBe("Confirmed");
    const replies = screen.getAllByTestId("ghost-reply");
    expect(replies).toHaveLength(2);
    expect(replies[1]!.textContent).toContain("plex rises again.");
    expect(store.getState().chat.pending).toBe(false);
    expect(onReply).toHaveBeenCalledWith(reply);
  });
});
