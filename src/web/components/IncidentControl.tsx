import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { INCIDENT_TYPES, type IncidentType, type StagedIncident } from "../../shared/types.js";
import { api as defaultApi, ApiError, type ApiClient } from "../api/rest.js";
import { hauntedStore, type HauntedStore } from "../state/store.js";
import "./controls.css";

/** Incidents that target one container. `cpu_spike` and `disk_full` are host incidents. */
export const CONTAINER_INCIDENT_TYPES: readonly IncidentType[] = [
  "memory_leak",
  "container_crash",
  "container_restart_loop",
];

export function isContainerIncident(type: IncidentType): boolean {
  return CONTAINER_INCIDENT_TYPES.includes(type);
}

export const INCIDENT_LABELS: Record<IncidentType, string> = {
  cpu_spike: "CPU spike",
  memory_leak: "Memory leak",
  disk_full: "Disk full",
  container_crash: "Container crash",
  container_restart_loop: "Container restart loop",
};

export interface IncidentControlProps {
  /** Store to read from. Defaults to the application store. */
  store?: HauntedStore;
  /** REST client. Defaults to the same-origin client. */
  api?: ApiClient;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.errorText ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

function describeIncident(i: StagedIncident): string {
  const label = INCIDENT_LABELS[i.type] ?? i.type;
  return i.target ? `${label} on ${i.target}` : label;
}

/**
 * Simulator-only control for staging and clearing incidents (Requirement 3.3).
 * Renders nothing unless the backend reports the simulator data source.
 */
export function IncidentControl({ store = hauntedStore, api = defaultApi }: IncidentControlProps) {
  const isSimulator = useStore(store, (s) => s.publicConfig?.dataSource === "simulator");
  const containers = useStore(store, (s) => s.snapshot?.containers);

  const [type, setType] = useState<IncidentType>(INCIDENT_TYPES[0]);
  const [container, setContainer] = useState("");
  const [incidents, setIncidents] = useState<StagedIncident[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!isSimulator) return;
    let cancelled = false;
    api.listIncidents().then(
      (list) => {
        if (!cancelled) setIncidents(list);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, isSimulator]);

  const run = useCallback(async (op: () => Promise<StagedIncident[]>) => {
    setBusy(true);
    setError(undefined);
    try {
      setIncidents(await op());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isSimulator) return null;

  const names = (containers ?? []).map((c) => c.name);
  const needsContainer = isContainerIncident(type);
  const target = names.includes(container) ? container : (names[0] ?? "");
  const canStage = !busy && (!needsContainer || target !== "");

  const stage = () =>
    run(() => api.stageIncident(needsContainer ? { type, container: target } : { type }));
  const clearAll = () => run(() => api.clearIncidents());

  return (
    <section className="incident-control card" aria-label="Incident control">
      <header className="card__header">
        <div>
          <h2 className="card__title">Summon an incident</h2>
          <p className="card__subtitle">Stage a simulated failure, then watch the ghost react.</p>
        </div>
        <span className="incident-control__badge">Simulator</span>
      </header>
      <div className="incident-control__row">
        <label className="field incident-control__field">
          <span>Incident</span>
          <select value={type} onChange={(e) => setType(e.target.value as IncidentType)} disabled={busy}>
            {INCIDENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {INCIDENT_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        {needsContainer && (
          <label className="field incident-control__field">
            <span>Container</span>
            <select
              value={target}
              onChange={(e) => setContainer(e.target.value)}
              disabled={busy || names.length === 0}
            >
              {names.length === 0 && <option value="">No containers yet</option>}
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="incident-control__buttons">
          <button type="button" className="btn btn--spirit" onClick={stage} disabled={!canStage}>
            Stage
          </button>
          <button type="button" className="btn btn--ghost" onClick={clearAll} disabled={busy}>
            Clear all
          </button>
        </div>
      </div>
      {error !== undefined && (
        <p className="incident-control__error" role="alert">
          {error}
        </p>
      )}
      {incidents.length === 0 ? (
        <p className="incident-control__empty">No incidents staged.</p>
      ) : (
        <ul className="incident-control__list" aria-label="Staged incidents">
          {incidents.map((i) => (
            <li key={`${i.type}:${i.target ?? ""}`}>{describeIncident(i)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default IncidentControl;
