import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { HauntingAlert } from "../../src/shared/types.js";
import { createHauntedStore } from "../../src/web/state/store.js";
import { AlertPopupStack } from "../../src/web/components/AlertPopupStack.js";

afterEach(cleanup);

function alert(overrides: Partial<HauntingAlert> = {}): HauntingAlert {
  return {
    id: "a1",
    key: "container_exited:container:plex",
    ruleId: "container_exited",
    subject: { kind: "container", name: "plex" },
    severity: "critical",
    measuredValue: "exited",
    detectedAt: "2025-10-31T00:00:10.000Z",
    message: "The spirit of plex has left its vessel. It now lies exited in the dark.",
    status: "active",
    ...overrides,
  };
}

describe("AlertPopupStack", () => {
  it("renders nothing without popups", () => {
    const { container } = render(<AlertPopupStack store={createHauntedStore()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows message, severity, and detection time for a raised alert (5.2)", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "alert.raised", alert: alert() });
    render(<AlertPopupStack store={store} />);

    const popup = screen.getByRole("alert");
    expect(within(popup).getByText(/spirit of plex/)).toBeTruthy();
    expect(within(popup).getByText(/critical/i)).toBeTruthy();
    const time = popup.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe("2025-10-31T00:00:10.000Z");
    expect(time?.textContent).toBe(new Date("2025-10-31T00:00:10.000Z").toLocaleTimeString());
  });

  it("uses role=status for warning alerts", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({
      type: "alert.raised",
      alert: alert({ id: "w1", key: "disk:filesystem:/", severity: "warning", message: "The disk groans at 97.0%." }),
    });
    render(<AlertPopupStack store={store} />);
    expect(within(screen.getByRole("status")).getByText(/warning/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes a popup when dismissed (5.4)", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "alert.raised", alert: alert() });
    render(<AlertPopupStack store={store} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(store.getState().popups).toEqual([]);
  });

  it("adds a recovery popup when the alert resolves (5.6)", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "alert.raised", alert: alert() });
    render(<AlertPopupStack store={store} />);

    act(() => {
      store.getState().applyEvent({
        type: "alert.resolved",
        alertId: "a1",
        resolvedAt: "2025-10-31T00:01:00.000Z",
        recoveryMessage: "The haunting of plex has lifted.",
        recoveryMessageId: "r1",
      });
    });

    const recovery = screen.getByRole("status");
    expect(within(recovery).getByText("The haunting of plex has lifted.")).toBeTruthy();
    expect(within(recovery).getByText(/recovered/i)).toBeTruthy();
    expect(recovery.querySelector("time")?.getAttribute("dateTime")).toBe("2025-10-31T00:01:00.000Z");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("shows a muted-speaker indicator when voice failed for the popup", () => {
    const store = createHauntedStore();
    store.getState().applyEvent({ type: "alert.raised", alert: alert() });
    render(<AlertPopupStack store={store} />);
    expect(screen.queryByRole("img", { name: "Voice failed" })).toBeNull();

    act(() => store.getState().setVoiceStatus("a1", "failed"));
    expect(screen.getByRole("img", { name: "Voice failed" })).toBeTruthy();
  });
});
