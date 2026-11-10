import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { StatusPanel } from "../../src/web/components/StatusPanel.js";
import { createHauntedStore } from "../../src/web/state/store.js";
import type { HauntingAlert, Snapshot } from "../../src/shared/types.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    readAt: "2025-01-01T12:00:00.000Z",
    host: {
      cpuPercent: 12.34,
      memoryUsedBytes: 8 * GiB,
      memoryTotalBytes: 32 * GiB,
      filesystems: [
        { mount: "/", usedBytes: 200 * GiB, totalBytes: 500 * GiB },
        { mount: "/mnt/media", usedBytes: 3 * 1024 * GiB, totalBytes: 4 * 1024 * GiB },
      ],
    },
    containers: [
      { name: "plex", state: "running", cpuPercent: 7.25, memoryBytes: 512 * MiB },
      { name: "pihole", state: "exited", cpuPercent: 0, memoryBytes: 0 },
    ],
    ...overrides,
  };
}

function alert(overrides: Partial<HauntingAlert>): HauntingAlert {
  return {
    id: "a1",
    key: "container_exited:container:pihole",
    ruleId: "container_exited",
    subject: { kind: "container", name: "pihole" },
    severity: "critical",
    measuredValue: "exited",
    detectedAt: "2025-01-01T12:00:00.000Z",
    message: "The spirit of pihole has left its vessel.",
    status: "active",
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("StatusPanel", () => {
  it("shows a placeholder before the first snapshot", () => {
    const store = createHauntedStore({ connection: "connected" });
    render(<StatusPanel store={store} />);
    expect(screen.getByRole("status").textContent).toMatch(/waiting for the first snapshot/i);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders host metrics and every container with shared formatting", () => {
    const store = createHauntedStore({ connection: "connected", snapshot: snapshot() });
    render(<StatusPanel store={store} />);

    expect(screen.getByText(/12\.3%/)).toBeTruthy(); // host CPU
    expect(screen.getByText(/25\.0%/)).toBeTruthy(); // memory 8 of 32 GiB
    expect(screen.getByText("Disk /")).toBeTruthy();
    expect(screen.getByText(/40\.0%/)).toBeTruthy(); // 200 of 500 GiB
    expect(screen.getByText("Disk /mnt/media")).toBeTruthy();
    expect(screen.getByText(/75\.0%/)).toBeTruthy();

    const table = screen.getByRole("table");
    const plexRow = within(table).getByRole("row", { name: /plex/ });
    expect(plexRow.textContent).toContain("running");
    expect(plexRow.textContent).toContain("7.3%");
    expect(plexRow.textContent).toContain("512.0 MiB");
    const piholeRow = within(table).getByRole("row", { name: /pihole/ });
    expect(piholeRow.textContent).toContain("exited");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("updates when a new snapshot event arrives", () => {
    const store = createHauntedStore({ connection: "connected", snapshot: snapshot() });
    render(<StatusPanel store={store} />);
    act(() => {
      store.getState().applyEvent({
        type: "snapshot",
        snapshot: snapshot({
          readAt: "2025-01-01T12:00:05.000Z",
          containers: [{ name: "homeassistant", state: "restarting", cpuPercent: 1, memoryBytes: GiB }],
        }),
      });
    });
    const table = screen.getByRole("table");
    expect(within(table).getByRole("row", { name: /homeassistant/ }).textContent).toContain("restarting");
    expect(within(table).queryByRole("row", { name: /plex/ })).toBeNull();
  });

  it("marks only subjects with unresolved alerts, using the highest severity", () => {
    const store = createHauntedStore({
      connection: "connected",
      snapshot: snapshot(),
      alerts: [
        alert({}),
        alert({
          id: "a2",
          key: "host_cpu:host:cpu",
          ruleId: "host_cpu",
          subject: { kind: "host", resource: "cpu" },
          severity: "warning",
          status: "resolved",
        }),
        alert({
          id: "a3",
          key: "disk:filesystem:/",
          ruleId: "disk",
          subject: { kind: "filesystem", mount: "/" },
          severity: "warning",
          measuredValue: "97.0%",
        }),
      ],
    });
    const { container } = render(<StatusPanel store={store} />);

    const piholeRow = within(screen.getByRole("table")).getByRole("row", { name: /pihole/ });
    expect(within(piholeRow).getByLabelText("severity critical")).toBeTruthy();
    const plexRow = within(screen.getByRole("table")).getByRole("row", { name: /plex/ });
    expect(within(plexRow).queryByLabelText(/severity/)).toBeNull();

    const root = container.querySelector('[data-subject="filesystem:/"]') as HTMLElement;
    expect(within(root).getByLabelText("severity warning")).toBeTruthy();
    const cpu = container.querySelector('[data-subject="host:cpu"]') as HTMLElement;
    expect(within(cpu).queryByLabelText(/severity/)).toBeNull();
  });

  it("shows a disconnected banner with the last snapshot time, or never", () => {
    const store = createHauntedStore({ connection: "disconnected" });
    render(<StatusPanel store={store} />);
    expect(screen.getByRole("alert").textContent).toMatch(/disconnected.*never/i);

    act(() => {
      store.getState().applyEvent({ type: "snapshot", snapshot: snapshot() });
    });
    const banner = screen.getByRole("alert");
    expect(banner.querySelector("time")?.getAttribute("dateTime")).toBe("2025-01-01T12:00:00.000Z");

    act(() => store.getState().setConnection("connected"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
