import { useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import type { AlertSeverity, ContainerInfo, HostMetrics, Thresholds } from "../../shared/types.js";
import { formatBytes, formatPercent, usagePercent } from "../../shared/format.js";
import { computeSeverityMarks } from "../../shared/severity.js";
import { hauntedStore, type HauntedStore } from "../state/store.js";
import "./StatusPanel.css";

export interface StatusPanelProps {
  /** Store to read from. Defaults to the application store; tests pass a fresh one. */
  store?: HauntedStore;
}

type Marks = ReadonlyMap<string, AlertSeverity>;

/** Used for bar threshold markers before the public config has loaded. */
const DEFAULT_THRESHOLDS: Thresholds = { cpuPercent: 90, cpuDurationSeconds: 30, memoryPercent: 90, diskPercent: 90 };

/** Formats an ISO time for display; falls back to the raw string when it cannot be parsed. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function clampPercent(x: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(x) ? x : 0));
}

function SeverityBadge({ severity }: { severity: AlertSeverity | undefined }) {
  if (!severity) return null;
  return (
    <span className={`severity-badge severity-badge--${severity}`} aria-label={`severity ${severity}`}>
      {severity}
    </span>
  );
}

interface MetricProps {
  subject: string;
  label: string;
  percent: number;
  threshold: number;
  mark: AlertSeverity | undefined;
  detail?: ReactNode;
}

function Metric({ subject, label, percent, threshold, mark, detail }: MetricProps) {
  const tone = mark ?? (percent > threshold ? "warning" : "ok");
  return (
    <div className={`metric metric--${tone}`} data-subject={subject}>
      <dt className="metric__label">
        {label} <SeverityBadge severity={mark} />
      </dt>
      <dd className="metric__body">
        <span className="metric__value">{formatPercent(percent)}</span>
        {detail && <span className="status-panel__detail">{detail}</span>}
        <span className="metric__bar" aria-hidden="true">
          <span className="metric__fill" style={{ width: `${clampPercent(percent)}%` }} />
          <span className="metric__threshold" style={{ left: `${clampPercent(threshold)}%` }} />
        </span>
      </dd>
    </div>
  );
}

function HostMetricsSection({ host, marks, thresholds }: { host: HostMetrics; marks: Marks; thresholds: Thresholds }) {
  return (
    <section className="status-panel__host" aria-labelledby="status-host-heading">
      <h3 id="status-host-heading" className="status-panel__section-title">
        Host
      </h3>
      <dl className="status-panel__metrics">
        <Metric
          subject="host:cpu"
          label="CPU"
          percent={host.cpuPercent}
          threshold={thresholds.cpuPercent}
          mark={marks.get("host:cpu")}
        />
        <Metric
          subject="host:memory"
          label="Memory"
          percent={usagePercent(host.memoryUsedBytes, host.memoryTotalBytes)}
          threshold={thresholds.memoryPercent}
          mark={marks.get("host:memory")}
          detail={`${formatBytes(host.memoryUsedBytes)} of ${formatBytes(host.memoryTotalBytes)}`}
        />
        {host.filesystems.map((fs) => {
          const key = `filesystem:${fs.mount}`;
          return (
            <Metric
              key={fs.mount}
              subject={key}
              label={`Disk ${fs.mount}`}
              percent={usagePercent(fs.usedBytes, fs.totalBytes)}
              threshold={thresholds.diskPercent}
              mark={marks.get(key)}
              detail={`${formatBytes(fs.usedBytes)} of ${formatBytes(fs.totalBytes)}`}
            />
          );
        })}
      </dl>
    </section>
  );
}

function ContainerTable({ containers, marks }: { containers: ContainerInfo[]; marks: Marks }) {
  const running = containers.filter((c) => c.state === "running").length;
  return (
    <section className="status-panel__containers" aria-labelledby="status-containers-heading">
      <div className="status-panel__section-head">
        <h3 id="status-containers-heading" className="status-panel__section-title">
          Containers
        </h3>
        <span className="status-panel__count">
          {running}/{containers.length} running
        </span>
      </div>
      {containers.length === 0 ? (
        <p className="status-panel__empty">No containers haunt this host.</p>
      ) : (
        <div className="status-panel__table-wrap">
          <table className="status-panel__table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  CPU
                </th>
                <th scope="col" className="num">
                  Memory
                </th>
                <th scope="col">Alert</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => {
                const key = `container:${c.name}`;
                const mark = marks.get(key);
                return (
                  <tr key={c.name} data-subject={key} className={mark ? `status-panel__row--${mark}` : undefined}>
                    <th scope="row">{c.name}</th>
                    <td>
                      <span className={`container-state container-state--${c.state}`}>{c.state}</span>
                    </td>
                    <td className="num">{formatPercent(c.cpuPercent)}</td>
                    <td className="num">{formatBytes(c.memoryBytes)}</td>
                    <td>
                      <SeverityBadge severity={mark} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
  const thresholds = useStore(store, (s) => s.publicConfig?.thresholds) ?? DEFAULT_THRESHOLDS;

  const marks = useMemo(() => computeSeverityMarks(alerts), [alerts]);
  const dataSourceMark = marks.get("data_source");

  return (
    <section className="status-panel card" aria-labelledby="status-panel-heading">
      <header className="card__header">
        <div>
          <h2 id="status-panel-heading" className="card__title">
            Status
          </h2>
          {snapshot && (
            <p className="card__subtitle status-panel__read-at">
              Read at <time dateTime={snapshot.readAt}>{formatTime(snapshot.readAt)}</time>
            </p>
          )}
        </div>
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
        <div className="status-panel__body">
          <HostMetricsSection host={snapshot.host} marks={marks} thresholds={thresholds} />
          <ContainerTable containers={snapshot.containers} marks={marks} />
        </div>
      ) : (
        <p className="status-panel__placeholder" role="status">
          Waiting for the first snapshot from beyond the veil…
        </p>
      )}
    </section>
  );
}
