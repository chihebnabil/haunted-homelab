/**
 * Formatting helpers shared by the fact sheet, alert templates, and the Web_App,
 * so displayed and spoken values are identical (Requirement 8.4).
 */

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Formats a percentage with one decimal, e.g. 97.345 -> "97.3%". */
export function formatPercent(x: number): string {
  return `${x.toFixed(1)}%`;
}

/**
 * Formats a byte count with binary units and one decimal, e.g. 536870912 -> "512.0 MiB".
 * Values of 1024 TiB or more stay in TiB.
 */
export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Rounding can push a value such as 1023.96 KiB to "1024.0 KiB"; move it to the next unit.
  if (Number(value.toFixed(1)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${sign}${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Returns used / total * 100, or 0 when total is not positive. */
export function usagePercent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}
