import { useMemo } from "react";
import { useStore } from "zustand";
import type { AlertSeverity, ContainerInfo, HostMetrics } from "../../shared/types.js";
import { formatBytes, formatPercent, usagePercent } from "../../shared/format.js";
import { computeSeverityMarks } from "../../shared/severity.js";
import { hauntedStore, type HauntedStore } from "../state/store.js";
import "./StatusPanel.css";

export interface StatusPanelProps {
  /** Store to read from. Defaults to the application store; tests pass a fresh one. */
  store?: HauntedStore;
}

type Marks = ReadonlyMap<string, AlertSeverity>;

/** Formats an ISO time for display; falls back to the raw string when it cannot be parsed. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function SeverityBadge({ severity }: { severity: AlertSeverity | undefined }) {
  if (!severity) return null;
  return (
    <span className={`severity-badge severity-badge--${severity}`} aria-label={`severity ${severity}`}>
      {severity}
    </span>
  );
}

function HostMetricsSection({ host, marks }: { host: HostMetrics; marks: Marks }) {
  const memoryPercent = usagePercent(host.memoryUsedBytes, host.memoryTotalBytes);
  return (
    <section className="status-panel__host" aria-labelledby="status-host-heading">
      <h3 id="status-host-heading">Host</h3>
      <dl className="status-panel__metrics">
        <div className="status-panel__metric" data-subject="host:cpu">
          <dt>CPU</dt>
          <dd>
            {formatPercent(host.cpuPercent)} <SeverityBadge severity={marks.get("host:cpu")} />
          </dd>
        </div>
        <div className="status-panel__metric" data-subject="host:memory">
          <dt>Memory</dt>
          <dd>
            {formatPercent(memoryPercent)}{" "}
            <span className="status-panel__detail">
              ({formatBytes(host.memoryUsedBytes)} of {formatBytes(host.memoryTotalBytes)})
            </span>{" "}
            <SeverityBadge severity={marks.get("host:memory")} />
          </dd>
        </div>
        {host.filesystems.map((fs) => {
          const key = `filesystem:${fs.mount}`;
          return (
            <div className="status-panel__metric" data-subject={key} key={fs.mount}>
              <dt>Disk {fs.mount}</dt>
              <dd>
                {formatPercent(usagePercent(fs.usedBytes, fs.totalBytes))}{" "}
                <span className="status-panel__detail">
                  ({formatBytes(fs.usedBytes)} of {formatBytes(fs.totalBytes)})
                </span>{" "}
                <SeverityBadge severity={marks.get(key)} />
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function ContainerTable({ containers, marks }: { containers: ContainerInfo[]; marks: Marks }) {
  return (
    <section className="status-panel__containers" aria-labelledby="status-containers-heading">
      <h3 id="status-containers-heading">Containers</h3>
      {containers.length === 0 ? (
        <p className="status-panel__empty">No containers haunt this host.</p>
      ) : (
        <table className="status-panel__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">State</th>
              <th scope="col">CPU</th>
              <th scope="col">Memory</th>
              <th scope="col">Alert</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const key = `container:${c.name}`;
              return (
                <tr key={c.name} data-subject={key}>
                  <th scope="row">{c.name}</th>
                  <td>
                    <span className={`container-state container-state--${c.state}`}>{c.state}</span>
                  </td>
                  <td>{formatPercent(c.cpuPercent)}</td>
                  <td>{formatBytes(c.memoryBytes)}</td>
                  <td>
                    <SeverityBadge severity={marks.get(key)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Live view of host metrics and every container in the latest Snapshot (Requirements 10.1, 10.2).
 * Re-renders on every store update from `snapshot` events (10.3), marks subjects with unresolved
 * alerts (10.4), and shows a disconnected banner with the last snapshot time (10.5).
 */
export function StatusPanel({ store = hauntedStore }: StatusPanelProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const alerts = useStore(store, (s) => s.alerts);
  const connection = useStore(store, (s) => s.connection);
  const lastSnapshotAt = useStore(store, (s) => s.lastSnapshotAt);

  const marks = useMemo(() => computeSeverityMarks(alerts), [alerts]);
  const dataSourceMark = marks.get("data_source");

  return (
    <section className="status-panel" aria-labelledby="status-panel-heading">
      <header className="status-panel__header">
        <h2 id="status-panel-heading">Status</h2>
        {dataSourceMark && (
          <span className="status-panel__data-source" data-subject="data_source">
            Data source <SeverityBadge severity={dataSourceMark} />
          </span>
        )}
      </header>

      {connection === "disconnected" && (
        <div className="status-panel__disconnected" role="alert">
          Disconnected from the backend. Last snapshot:{" "}
          {lastSnapshotAt ? <time dateTime={lastSnapshotAt}>{formatTime(lastSnapshotAt)}</time> : "never"}
        </div>
      )}

      {snapshot ? (
        <>
          <p className="status-panel__read-at">
            Read at <time dateTime={snapshot.readAt}>{formatTime(snapshot.readAt)}</time>
          </p>
          <HostMetricsSection host={snapshot.host} marks={marks} />
          <ContainerTable containers={snapshot.containers} marks={marks} />
        </>
      ) : (
        <p className="status-panel__placeholder" role="status">
          Waiting for the first snapshot from beyond the veil…
        </p>
      )}
    </section>
  );
}
