import { formatBytes, formatNumber, formatValue, percent, rowRange } from "./format";
import { KINDS } from "./kinds";
import { METADATA_BLOCK_COUNT } from "./duckdb/header";
import { leafAt, segmentLabel, type DuckDBModel, type Piece } from "./duckdb/model";

export interface PopoverContent {
  title: string;
  /** Column path, for pieces that belong to one column. */
  column: string | null;
  where: string;
  what: string;
  rows: [string, string][];
}

const COMPATIBILITY = ["", "v0.10.2"];

/** The details shown when hovering or tapping a piece of the file. */
export function describePiece(p: Piece, model: DuckDBModel): PopoverContent {
  const leaf = "chunk" in p ? leafAt(model.leaves, p.chunk.leaf) : null;
  const size = p.end - p.start;
  const rows: [string, string][] = [
    ["Bytes", `${formatNumber(p.start)} – ${formatNumber(p.end)}`],
    ["Size", `${formatBytes(size)} · ${percent(size, model.fileSize)} of file`],
  ];

  switch (p.kind) {
    case "segment":
    case "validity": {
      const { row, stats } = p.segment;
      if (p.extent === "blockEnd") rows[1] = ["Size", `up to ${formatBytes(size)} · runs to the block end`];
      if (p.extent === "measured") rows[1] = ["Size", `${formatBytes(size)} · to its last non-zero byte`];
      rows.push(["Rows", rowRange(p.firstRow, row.count)], ["Compression", row.compression]);
      if (p.kind === "segment") rows.push(["Type", row.segmentType]);
      if (p.segment.row.path.length > 1) rows.push(["Part", segmentLabel(p.segment)]);
      if (stats.bounds) {
        rows.push(
          ["min", formatValue(stats.bounds.min, leaf?.type)],
          ["max", formatValue(stats.bounds.max, leaf?.type)],
        );
      }
      if (stats.hasNull !== null) rows.push(["NULLs", stats.hasNull ? "some" : "none"]);
      rows.push(["Block", `${p.block} · offset ${formatNumber(row.blockOffset)}`]);
      if (p.shared > 1) rows.push(["Shared", `with ${p.shared - 1} other segment${p.shared === 2 ? "" : "s"}`]);
      if (row.segmentInfo) rows.push(["Info", row.segmentInfo]);
      if (row.hasUpdates) rows.push(["Updates", "pending, not merged yet"]);
      break;
    }
    case "overflow":
      rows.push(["Block", String(p.block)], ["Compression", p.segment.row.compression]);
      break;
    case "metadata":
    case "metadataFree":
      rows.push(
        ["Block", String(p.block)],
        [
          "Sub-blocks",
          `${p.from === p.to ? p.from : `${p.from}–${p.to}`} of ${METADATA_BLOCK_COUNT} (${formatNumber(p.to - p.from + 1)})`,
        ],
      );
      break;
    case "slack":
      rows.push(["Block", String(p.block)]);
      break;
    case "missing":
      rows.push(["Block", String(p.block)], ["File ends", `at byte ${formatNumber(model.fileSize)}`]);
      break;
    case "free":
    case "unknown":
    case "unread":
      rows.push(["Block", String(p.block)]);
      if (p.kind === "unknown" && model.indexes.length)
        rows.push(["Indexes", model.indexes.map((i) => i.name).join(", ")]);
      break;
    case "mainHeader":
      rows.push(
        ["Magic", "DUCK"],
        ["Storage", `version ${model.file.storageVersion}`],
        ["Created by", `DuckDB ${model.file.libraryVersion} (${model.file.sourceId})`],
      );
      break;
    case "dbHeader": {
      const h = p.header;
      rows.push(
        ["State", p.active ? "active" : "previous checkpoint"],
        ["Iteration", formatNumber(h.iteration)],
        ["Blocks", `${formatNumber(h.blockCount)} × ${formatBytes(h.blockAllocSize)}`],
        ["Metadata", h.metaBlock ? `block ${h.metaBlock.block} · sub-block ${h.metaBlock.index}` : "none"],
        ["Free list", h.freeList ? `block ${h.freeList.block} · sub-block ${h.freeList.index}` : "none"],
        ["Vector size", formatNumber(h.vectorSize)],
        ["Compatible", COMPATIBILITY[h.serializationCompatibility] ?? `level ${h.serializationCompatibility}`],
      );
      break;
    }
    case "tail":
      break;
    default: {
      const unhandled: never = p;
      throw new Error(`unhandled piece ${JSON.stringify(unhandled)}`);
    }
  }

  return {
    title: KINDS[p.kind].label,
    column: leaf?.path ?? null,
    where: whereOf(p, model),
    what: KINDS[p.kind].what,
    rows,
  };
}

function whereOf(p: Piece, model: DuckDBModel): string {
  if ("chunk" in p) return `${model.tables[p.chunk.table]?.qualified} · row_group[${p.chunk.rg}]`;
  if (p.kind === "mainHeader") return "start of file";
  if (p.kind === "dbHeader") return `header slot ${p.slot + 1} · offset ${formatNumber(p.start)}`;
  if (p.kind === "tail") return "end of file";
  return `block ${p.block}`;
}

/** The row group a click on this piece would open, if any. */
export function rowGroupOf(p: Piece): { table: number; rg: number } | null {
  return "chunk" in p ? { table: p.chunk.table, rg: p.chunk.rg } : null;
}
