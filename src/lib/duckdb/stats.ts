export type StatValue = number | string | Date;

export interface Bounds {
  min: StatValue;
  max: StatValue;
}

export interface SegmentStats {
  bounds: Bounds | null;
  /** Null when the statistics don't say. */
  hasNull: boolean | null;
}

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL.*)$/;
const TEMPORAL = /^(DATE|TIMESTAMP.*)$/;

function typedValue(raw: string, type: string): StatValue {
  if (NUMERIC.test(type)) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (TEMPORAL.test(type)) {
    const iso = raw.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
    return Number.isNaN(d.getTime()) ? raw : d;
  }
  return raw;
}

/**
 * Parses a segment's statistics as `pragma_storage_info` prints them, e.g.
 * `[Min: 1, Max: 9][Has Null: false, Has No Null: true]`. String minimums and maximums are cut to 8 bytes.
 */
export function parseStats(stats: string, type: string): SegmentStats {
  // Lists and structs print their children's statistics nested as `[[...]]`; only a segment's own range counts.
  const range = stats.match(/^\[Min: (.*?), Max: (.*?)(?:, Has Unicode: .*?)?\]/);
  const nulls = stats.match(/Has Null: (true|false)/);
  return {
    bounds: range ? { min: typedValue(range[1] ?? "", type), max: typedValue(range[2] ?? "", type) } : null,
    hasNull: nulls ? nulls[1] === "true" : null,
  };
}

function compare(a: StatValue, b: StatValue): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The union of several ranges, e.g. every segment of a column in one row group. */
export function mergeBounds(all: (Bounds | null)[]): Bounds | null {
  if (!all.length || all.some((b) => !b)) return null;
  const known = all as Bounds[];
  return known.reduce((acc, b) => ({
    min: compare(b.min, acc.min) < 0 ? b.min : acc.min,
    max: compare(b.max, acc.max) > 0 ? b.max : acc.max,
  }));
}

type Order = "single" | "missing" | "constant" | "sorted" | "overlapping";

/** How a column's min/max ranges line up across row groups, which decides whether zonemaps can skip any. */
export function orderOf(bounds: (Bounds | null)[]): Order {
  if (bounds.some((b) => !b)) return "missing";
  const known = bounds as Bounds[];
  if (known.length < 2) return "single";
  const [first] = known as [Bounds];
  if (known.every((b) => compare(b.min, first.min) === 0 && compare(b.max, first.max) === 0)) return "constant";
  const sorted = known.every((b, i) => i === 0 || compare(b.min, (known[i - 1] as Bounds).max) >= 0);
  return sorted ? "sorted" : "overlapping";
}

/** Maps a min/max value to 0..1 across all row groups: by value for numbers and dates, by rank otherwise. */
export function rangePositions(bounds: Bounds[]): ((v: StatValue) => number) | null {
  const sample = bounds[0]?.min;
  if (sample === undefined) return null;
  const values = bounds.flatMap((b) => [b.min, b.max]);
  if (typeof sample === "number" || sample instanceof Date) {
    const nums = values.map(Number);
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    return (v) => (hi > lo ? (Number(v) - lo) / (hi - lo) : 0);
  }
  const ranked = [...new Set(values.map(String))].sort(compare);
  const rank = new Map(ranked.map((v, i) => [v, i]));
  return (v) => (ranked.length > 1 ? (rank.get(String(v)) ?? 0) / (ranked.length - 1) : 0);
}
