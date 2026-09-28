import type { StatValue } from "./duckdb/stats";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 100 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatNumber(n: number | bigint): string {
  return n.toLocaleString("en-US");
}

export function percent(part: number, whole: number): string {
  const v = (part / whole) * 100;
  if (v > 0 && v < 0.01) return "<0.01%";
  return `${v < 0.1 ? v.toFixed(2) : v.toFixed(1)}%`;
}

export function rowRange(firstRow: number, numRows: number): string {
  return `${formatNumber(firstRow)} – ${formatNumber(firstRow + numRows - 1)}`;
}

const MAX_STRING = 60;
const TEXT = /^(VARCHAR|UUID|ENUM.*)$/;

/** A statistics value as SQL would write it: quoted strings, trimmed floats, ISO timestamps. */
export function formatValue(v: StatValue | undefined | null, type = ""): string {
  if (v === undefined || v === null) return "–";
  if (v instanceof Date) {
    return v
      .toISOString()
      .replace("T", " ")
      .replace(/(:00)?\.000Z$/, "")
      .replace(/Z$/, "");
  }
  // `+ 0` turns -0, which float stats often store as a min, into 0.
  if (typeof v === "number") return Number.isInteger(v) ? formatNumber(v + 0) : String(+v.toPrecision(6));
  return TEXT.test(type) ? JSON.stringify(v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v) : v;
}
