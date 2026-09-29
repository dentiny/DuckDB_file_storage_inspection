import { formatBytes, formatNumber, percent } from "../format";
import { ROW_GROUP_SIZE, type DuckDBModel } from "./model";
import { orderOf } from "./stats";
import { isIncomplete, type WalFile } from "./wal";

export interface Check {
  label: string;
  passed: boolean;
  /** Column or table names the check is about. */
  columns: string[];
  /** One sentence on what this means for readers. */
  detail: string;
}

const MAX_DETAIL_NAMES = 8;
/** More free blocks than this share of the file counts as bloat worth reclaiming. */
const MAX_FREE_SHARE = 0.1;

/** How well DuckDB can skip, decompress and reuse this file: zonemaps, compression, row group fill, free space. */
export function readEfficiency(model: DuckDBModel, log: WalFile | null = null): Check[] {
  const { tables, leaves, header } = model;
  const sorted = leaves
    .filter((leaf) => {
      const groups = tables[leaf.table]?.rowGroups ?? [];
      return orderOf(groups.map((g) => g.chunks[leaf.column]?.bounds ?? null)) === "sorted";
    })
    .map((l) => l.path);

  const uncompressed = leaves
    .filter((leaf) =>
      tables[leaf.table]?.rowGroups.some((g) =>
        g.chunks[leaf.column]?.segments.some((s) => !s.validity && s.row.compression === "Uncompressed" && s.piece),
      ),
    )
    .map((l) => l.path);

  const ragged = tables
    .filter((t) => t.rowGroups.slice(0, -1).some((g) => g.numRows < ROW_GROUP_SIZE))
    .map((t) => t.qualified);

  const freeBytes = model.blocks.free.length * header.blockAllocSize;
  const compact = model.usage === null || freeBytes <= model.fileSize * MAX_FREE_SHARE;
  const slack = model.pieces.reduce((sum, p) => sum + (p.kind === "slack" ? p.end - p.start : 0), 0);
  const slackNote = slack ? ` Partly filled blocks leave another ${formatBytes(slack)} unused.` : "";

  const pending = tables
    .filter((t) => t.rowGroups.some((g) => g.chunks.some((c) => c.segments.some((s) => s.row.hasUpdates))))
    .map((t) => t.qualified);
  const wal = log?.size ?? model.walSize ?? 0;
  const entries = log ? log.entries.filter((e) => e.category !== "commit" && e.typeName !== "WAL_VERSION").length : 0;
  const incomplete = log ? log.entries.filter(isIncomplete).length : 0;
  const walNote = log
    ? ` It holds ${formatNumber(entries)} changes in ${formatNumber(log.commits)} commits${incomplete ? `, and ${formatNumber(incomplete)} incomplete entries DuckDB would skip` : ""}.`
    : "";

  return [
    {
      label: "Sorted",
      passed: sorted.length > 0,
      columns: sorted,
      detail: sorted.length
        ? `Filters on ${listNames(sorted)} skip row groups: their zonemaps (min/max) don't overlap.`
        : "No column has non-overlapping min/max across row groups, so range filters scan every row group.",
    },
    {
      label: "Compressed",
      passed: uncompressed.length === 0,
      columns: uncompressed,
      detail: uncompressed.length
        ? `${listNames(uncompressed)} ${uncompressed.length === 1 ? "has" : "have"} uncompressed segments, usually tiny tables or data DuckDB couldn't compress.`
        : "Every stored segment uses a compression method.",
    },
    {
      label: "Full row groups",
      passed: ragged.length === 0,
      columns: ragged,
      detail: ragged.length
        ? `${listNames(ragged)} ${ragged.length === 1 ? "has" : "have"} row groups under ${formatNumber(ROW_GROUP_SIZE)} rows before the last, from many small appends; fewer, fuller row groups compress and scan better.`
        : `Every row group but each table's last holds ${formatNumber(ROW_GROUP_SIZE)} rows.`,
    },
    {
      label: "Compact",
      passed: compact,
      columns: [],
      detail:
        model.usage === null
          ? "The free list couldn't be read, so free blocks can't be told apart from index blocks."
          : model.blocks.free.length
            ? `${formatNumber(model.blocks.free.length)} free blocks (${formatBytes(freeBytes)}, ${percent(freeBytes, model.fileSize)} of the file) left by deletes and drops. DuckDB reuses them; copying the database to a new file reclaims them.${slackNote}`
            : `No free blocks: every block holds live data or metadata.${slackNote}`,
    },
    {
      label: "Checkpointed",
      passed: wal === 0 && pending.length === 0,
      columns: pending,
      detail:
        wal > 0
          ? `A ${formatBytes(wal)} write-ahead log sits next to the file. Its changes aren't in these blocks until the next checkpoint.${walNote}`
          : pending.length
            ? `${listNames(pending)} ${pending.length === 1 ? "has" : "have"} updates not yet merged into their segments.`
            : model.walSize === null && !log
              ? "Every segment is checkpointed. A file picked in the browser can't show whether a .wal sits next to it; pick both to see it."
              : "Every change is checkpointed into the file; there is no write-ahead log.",
    },
  ];
}

/** Badge text: the first name plus a count, so files with many matching columns keep a one-line badge. */
export function summarizeNames(names: string[]): string {
  if (names.length <= 2 && names.join(", ").length <= 32) return names.join(", ");
  return `${names[0]} +${names.length - 1}`;
}

function listNames(names: string[]): string {
  if (names.length <= MAX_DETAIL_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_DETAIL_NAMES).join(", ")} and ${formatNumber(names.length - MAX_DETAIL_NAMES)} more`;
}
