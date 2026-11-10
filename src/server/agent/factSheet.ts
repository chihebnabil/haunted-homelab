/**
 * Deterministic fact sheet built from a Snapshot (Requirements 6.4, 8.4).
 * Every value is formatted with the shared formatters, so the numbers the LLM
 * sees are identical to the ones the Status_Panel displays.
 */

import { formatBytes, formatPercent, usagePercent } from "../../shared/format.js";
import type { ContainerState, Snapshot } from "../../shared/types.js";

export interface FactSheet {
  host: {
    /** Host CPU usage, e.g. "12.3%". */
    cpu: string;
    /** Host memory usage, e.g. "31.3%". */
    memory: string;
    /** e.g. "10.0 GiB". */
    memoryUsed: string;
    /** e.g. "32.0 GiB". */
    memoryTotal: string;
    /** Disk usage per mount, `used` as a percentage, e.g. "40.1%". */
    disks: { mount: string; used: string }[];
  };
  containers: { name: string; state: ContainerState; cpu: string; memory: string }[];
}

export function buildFactSheet(s: Snapshot): FactSheet {
  const { host } = s;
  return {
    host: {
      cpu: formatPercent(host.cpuPercent),
      memory: formatPercent(usagePercent(host.memoryUsedBytes, host.memoryTotalBytes)),
      memoryUsed: formatBytes(host.memoryUsedBytes),
      memoryTotal: formatBytes(host.memoryTotalBytes),
      disks: host.filesystems.map((fs) => ({
        mount: fs.mount,
        used: formatPercent(usagePercent(fs.usedBytes, fs.totalBytes)),
      })),
    },
    containers: s.containers.map((c) => ({
      name: c.name,
      state: c.state,
      cpu: formatPercent(c.cpuPercent),
      memory: formatBytes(c.memoryBytes),
    })),
  };
}

/**
 * Renders the fact sheet as one line per fact. The prompt builder sends these lines
 * to the LLM, and the fact guard derives its allowed quantities from the same lines.
 */
export function factLines(f: FactSheet): string[] {
  return [
    `host CPU: ${f.host.cpu}`,
    `host memory: ${f.host.memory} (${f.host.memoryUsed} of ${f.host.memoryTotal})`,
    ...f.host.disks.map((d) => `filesystem ${d.mount}: ${d.used} used`),
    ...f.containers.map(
      (c) => `container ${c.name}: ${c.state}, CPU ${c.cpu}, memory ${c.memory}`,
    ),
  ];
}
