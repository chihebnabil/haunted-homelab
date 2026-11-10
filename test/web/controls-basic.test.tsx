import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IncidentControl } from "../../src/web/components/IncidentControl.js";
import { VoiceToggle } from "../../src/web/components/VoiceToggle.js";
import { PrivacyNotice } from "../../src/web/components/PrivacyNotice.js";
import { ApiError, type ApiClient } from "../../src/web/api/rest.js";
import { createHauntedStore } from "../../src/web/state/store.js";
import type { PublicConfig, Snapshot, StageIncidentRequest, StagedIncident } from "../../src/shared/types.js";

afterEach(cleanup);

function config(dataSource: PublicConfig["dataSource"]): PublicConfig {
  return {
    dataSource,
    aiGateway: "openrouter",
    llmModel: "openai/gpt-4o-mini",
    ttsModel: "openai/gpt-4o-mini-tts-2025-12-15",
    pollIntervalMs: 5000,
    thresholds: { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 },
  };
}

const snapshot: Snapshot = {
  readAt: "2024-01-01T00:00:00.000Z",
  containers: [
    { name: "plex", state: "running", cpuPercent: 5, memoryBytes: 1 },
    { name: "pihole", state: "running", cpuPercent: 3, memoryBytes: 1 },
  ],
  host: { cpuPercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 2, filesystems: [] },
};

/** In-memory incident API with the same staging rules as the simulator endpoints. */
function incidentApi(known: string[]) {
  let incidents: StagedIncident[] = [];
  const staged: StageIncidentRequest[] = [];
  const api = {
    listIncidents: async () => incidents,
    stageIncident: async (req: StageIncidentRequest) => {
      staged.push(req);
      if (req.container !== undefined && !known.includes(req.container)) {
        throw new ApiError("http", 400, { error: `Unknown container "${req.container}"` }, "400");
      }
      incidents = [...incidents, { type: req.type, target: req.container, stagedAt: 0 }];
      return incidents;
    },
    clearIncidents: async () => {
      incidents = [];
      return incidents;
    },
  } as unknown as ApiClient;
  return { api, staged };
}

describe("IncidentControl", () => {
  it("renders nothing outside simulator mode or before config loads", () => {
    const { api } = incidentApi([]);
    const store = createHauntedStore();
    const { container, rerender } = render(<IncidentControl store={store} api={api} />);
    expect(container.innerHTML).toBe("");
    act(() => store.getState().setPublicConfig(config("docker")));
    rerender(<IncidentControl store={store} api={api} />);
    expect(container.innerHTML).toBe("");
  });

  it("stages a host incident, a container incident, and clears all", async () => {
    const { api, staged } = incidentApi(["plex", "pihole"]);
    const store = createHauntedStore({ publicConfig: config("simulator"), snapshot });
    render(<IncidentControl store={store} api={api} />);

    expect(screen.queryByLabelText("Container")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await screen.findByText("CPU spike");
    expect(staged[0]).toEqual({ type: "cpu_spike" });

    fireEvent.change(screen.getByLabelText("Incident"), { target: { value: "container_crash" } });
    fireEvent.change(screen.getByLabelText("Container"), { target: { value: "pihole" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await screen.findByText("Container crash on pihole");
    expect(staged[1]).toEqual({ type: "container_crash", container: "pihole" });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await screen.findByText("No incidents staged.");
  });

  it("shows the backend error message when staging fails", async () => {
    const { api } = incidentApi([]);
    const store = createHauntedStore({ publicConfig: config("simulator"), snapshot });
    render(<IncidentControl store={store} api={api} />);
    fireEvent.change(screen.getByLabelText("Incident"), { target: { value: "memory_leak" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    expect((await screen.findByRole("alert")).textContent).toBe('Unknown container "plex"');
  });
});

describe("VoiceToggle", () => {
  it("is on by default and toggles voiceEnabled", () => {
    const store = createHauntedStore();
    render(<VoiceToggle store={store} />);
    const toggle = screen.getByRole("switch", { name: "Voice" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(store.getState().voiceEnabled).toBe(false);
    expect(toggle.checked).toBe(false);
  });

  it("hides the wake button after a successful unlock and keeps it after a failure", async () => {
    const store = createHauntedStore();
    const onUnlock = vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined);
    render(<VoiceToggle store={store} onUnlock={onUnlock} />);

    fireEvent.click(screen.getByRole("button", { name: "Wake the ghost" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Wake the ghost" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Wake the ghost" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Wake the ghost" })).toBeNull());
    expect(onUnlock).toHaveBeenCalledTimes(2);
  });
});

describe("PrivacyNotice", () => {
  it("names OpenRouter generically before config loads, then both model slugs", () => {
    const store = createHauntedStore();
    render(<PrivacyNotice store={store} />);
    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toContain("OpenRouter");
    act(() => store.getState().setPublicConfig(config("simulator")));
    expect(footer.textContent).toContain("OpenRouter");
    expect(footer.textContent).toContain("openai/gpt-4o-mini (LLM)");
    expect(footer.textContent).toContain("openai/gpt-4o-mini-tts-2025-12-15 (text-to-speech)");
  });
});
