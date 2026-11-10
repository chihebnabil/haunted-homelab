import { useMemo, type ReactNode } from "react";
import { Cpu, HardDrive, MemoryStick, WifiOff } from "lucide-react";
import { useStore } from "zustand";
import type { AlertSeverity, ContainerInfo, HauntingAlert, HostMetrics, Thresholds } from "../../shared/types.js";
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

/** One-line summary of the unresolved alerts, shown next to the panel title. */
function HauntingSummary({ alerts }: { alerts: readonly HauntingAlert[] }) {
  const active = alerts.filter((a) => a.status === "active");
  const tone = active.length === 0 ? "calm" : active.some((a) => a.severity === "critical") ? "critical" : "warning";
  const text =
    active.length === 0 ? "All quiet" : `${active.length} active ${active.length === 1 ? "haunting" : "hauntings"}`;
  return <span className={`status-summary status-summary--${tone}`}>{text}</span>;
}

interface MetricProps {
  subject: string;
  label: string;
  icon: ReactNode;
  percent: number;
  threshold: number;
  /** Tooltip for the threshold marker. */
  thresholdHint: string;
  mark: AlertSeverity | undefined;
  detail?: ReactNode;
}

/** "6.3 GiB of 32.0 GiB", where neither value can break across lines. */
function usedOf(used: number, total: number): ReactNode {
  return (
    <>
      <span className="nowrap">{formatBytes(used)}</span> of <span className="nowrap">{formatBytes(total)}</span>
    </>
  );
}

function Metric({ subject, label, icon, percent, threshold, thresholdHint, mark, detail }: MetricProps) {
  const tone = mark ?? (percent > threshold ? "warning" : "ok");
  return (
    <div className={`metric metric--${tone}`} data-subject={subject}>
      <dt className="metric__label">
        {icon}
        {/* Long mount paths are cut with an ellipsis; the tooltip keeps the full path. */}
        <span className="metric__name" title={label}>
          {label}
        </span>{" "}
        <SeverityBadge severity={mark} />
      </dt>
      <dd className="metric__body">
        <span className="metric__value">{formatPercent(percent)}</span>
        {detail && <span className="status-panel__detail">{detail}</span>}
        <span className="metric__meter" title={thresholdHint}>
          <span className="metric__bar" aria-hidden="true">
            <span className="metric__fill" style={{ width: `${clampPercent(percent)}%` }} />
            <span className="metric__threshold" style={{ left: `${clampPercent(threshold)}%` }} />
          </span>
        </span>
      </dd>
    </div>
  );
}

function HostMetricsSection({ host, marks, thresholds }: { host: HostMetrics; marks: Marks; thresholds: Thresholds }) {
  const diskHint = `Alert above ${formatPercent(thresholds.diskPercent)}`;
  return (
    <section className="status-panel__host" aria-labelledby="status-host-heading">
      <h3 id="status-host-heading" className="status-panel__section-title">
        Host
      </h3>
      <dl className="status-panel__metrics">
        <Metric
          subject="host:cpu"
          label="CPU"
          icon={<Cpu />}
          percent={host.cpuPercent}
          threshold={thresholds.cpuPercent}
          thresholdHint={`Alert after ${thresholds.cpuDurationSeconds} s above ${formatPercent(thresholds.cpuPercent)}`}
          mark={marks.get("host:cpu")}
          // CPU alerts need sustained load, which surprises people when a spike does not alert at once.
          detail={
            <>
              Alerts at {formatPercent(thresholds.cpuPercent)}{" "}
              <span className="nowrap">for {thresholds.cpuDurationSeconds} s</span>
            </>
          }
        />
        <Metric
          subject="host:memory"
          label="Memory"
          icon={<MemoryStick />}
          percent={usagePercent(host.memoryUsedBytes, host.memoryTotalBytes)}
          threshold={thresholds.memoryPercent}
          thresholdHint={`Alert above ${formatPercent(thresholds.memoryPercent)}`}
          mark={marks.get("host:memory")}
          detail={usedOf(host.memoryUsedBytes, host.memoryTotalBytes)}
        />
        {host.filesystems.map((fs) => {
          const key = `filesystem:${fs.mount}`;
          return (
            <Metric
              key={fs.mount}
              subject={key}
              label={`Disk ${fs.mount}`}
              icon={<HardDrive />}
              percent={usagePercent(fs.usedBytes, fs.totalBytes)}
              threshold={thresholds.diskPercent}
              thresholdHint={diskHint}
              mark={marks.get(key)}
              detail={usedOf(fs.usedBytes, fs.totalBytes)}
            />
          );
        })}
      </dl>
    </section>
  );
}

function ContainerTable({ containers, marks }: { containers: ContainerInfo[]; marks: Marks }) {
  const running = containers.filter((c) => c.state === "running").length;
  const allRunning = containers.length > 0 && running === containers.length;
  return (
    <section className="status-panel__containers" aria-labelledby="status-containers-heading">
      <div className="status-panel__section-head">
        <h3 id="status-containers-heading" className="status-panel__section-title">
          Containers
        </h3>
        <span className={`status-panel__count${allRunning ? "" : " status-panel__count--down"}`}>
          {running}/{containers.length} running
        </span>
      </div>
      {containers.length === 0 ? (
        <p className="status-panel__empty">No containers haunt this host.</p>
      ) : (
        <div className="status-panel__table-wrap">
          {/* Explicit roles keep the table semantics when narrow screens restyle the rows as cards. */}
          <table className="status-panel__table" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">
                  Name
                </th>
                <th scope="col" role="columnheader">
                  State
                </th>
                <th scope="col" role="columnheader" className="num">
                  CPU
                </th>
                <th scope="col" role="columnheader" className="num">
                  Memory
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {containers.map((c) => {
                const key = `container:${c.name}`;
                const mark = marks.get(key);
                return (
                  <tr
                    key={c.name}
                    role="row"
                    data-subject={key}
                    data-state={c.state}
                    className={mark ? `status-panel__row--${mark}` : undefined}
                  >
                    <th scope="row" role="rowheader">
                      <span className="status-panel__name">{c.name}</span>
                      <SeverityBadge severity={mark} />
                    </th>
                    <td role="cell">
                      <span className={`container-state container-state--${c.state}`}>{c.state}</span>
                    </td>
                    <td role="cell" className="num" data-label="CPU">
                      <span className="status-panel__cpu">
                        <span className="status-panel__cpu-bar" aria-hidden="true">
                          <span style={{ width: `${clampPercent(c.cpuPercent)}%` }} />
                        </span>
                        <span className="status-panel__cpu-value">{formatPercent(c.cpuPercent)}</span>
                      </span>
                    </td>
                    <td role="cell" className="num" data-label="Memory">
                      {formatBytes(c.memoryBytes)}
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

/** Shimmering stand-ins for the metric tiles and table rows while the first snapshot loads. */
function LoadingSkeleton() {
  return (
    <div className="status-panel__skeleton" aria-hidden="true">
      <div className="status-panel__skeleton-tiles">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton status-panel__skeleton-tile" />
        ))}
      </div>
      <div className="status-panel__skeleton-rows">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="skeleton status-panel__skeleton-row" />
        ))}
      </div>
    </div>
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
      <header className="card__header status-panel__header">
        <div className="status-panel__heading">
          <h2 id="status-panel-heading" className="card__title">
            Status
          </h2>
          {snapshot && (
            <p className="card__subtitle status-panel__read-at">
              {/* Remounts on every snapshot, so its pulse replays as a heartbeat. */}
              <span key={snapshot.readAt} className="status-panel__beat" aria-hidden="true" />
              <span>
                Read at <time dateTime={snapshot.readAt}>{formatTime(snapshot.readAt)}</time>
              </span>
            </p>
          )}
        </div>
        <div className="status-panel__header-side">
          {dataSourceMark && (
            <span className="status-panel__data-source" data-subject="data_source">
              Data source <SeverityBadge severity={dataSourceMark} />
            </span>
          )}
          {snapshot && <HauntingSummary alerts={alerts} />}
        </div>
      </header>

      {connection === "disconnected" && (
        <div className="status-panel__disconnected" role="alert">
          <WifiOff />
          <span>
            Disconnected from the backend. Last snapshot:{" "}
            {lastSnapshotAt ? <time dateTime={lastSnapshotAt}>{formatTime(lastSnapshotAt)}</time> : "never"}
          </span>
        </div>
      )}

      {snapshot ? (
        <div className="status-panel__body">
          <HostMetricsSection host={snapshot.host} marks={marks} thresholds={thresholds} />
          <ContainerTable containers={snapshot.containers} marks={marks} />
        </div>
      ) : (
        <div className="status-panel__loading">
          <LoadingSkeleton />
          <p className="status-panel__placeholder" role="status">
            Waiting for the first snapshot from beyond the veil…
          </p>
        </div>
      )}
    </section>
  );
}
