import type { Catalog, CatalogEntry, StorageRow, TableDef } from "./catalog";
import {
  activeHeader,
  BLOCK_HEADER_SIZE,
  BLOCKS_START,
  blockStart,
  HEADER_SIZE,
  METADATA_BLOCK_COUNT,
  metadataSubBlockSize,
  type BlockUsage,
  type DatabaseHeader,
  type FileHeader,
} from "./header";
import { mergeBounds, parseStats, type Bounds, type SegmentStats } from "./stats";

/** DuckDB's default rows per row group; smaller ones before a table's last row group mean fragmented appends. */
export const ROW_GROUP_SIZE = 122_880;

export interface Leaf {
  table: number;
  /** Column index within its table. */
  column: number;
  name: string;
  type: string;
  /** `schema.table.column`, or just the column when the file has one table in `main`. */
  path: string;
}

export interface Segment {
  row: StorageRow;
  stats: SegmentStats;
  /** A validity mask rather than values. */
  validity: boolean;
  /** Where it sits in the file; null for segments with no bytes of their own, e.g. constant compression. */
  piece: SegmentPiece | null;
}

export interface Chunk {
  table: number;
  rg: number;
  leaf: number;
  segments: Segment[];
  /** Placed segments and overflow blocks: values first, then validity and nested children. */
  parts: (SegmentPiece | OverflowPiece)[];
  bytes: number;
  bounds: Bounds | null;
  hasNull: boolean | null;
  compressions: string[];
}

export interface RowGroupInfo {
  table: number;
  rg: number;
  firstRow: number;
  numRows: number;
  chunks: Chunk[];
  bytes: number;
  /** Blocks any of its segments touch, ascending. */
  blocks: number[];
}

export interface TableInfo {
  index: number;
  def: TableDef;
  /** `schema.name`. */
  qualified: string;
  leaves: number[];
  rowGroups: RowGroupInfo[];
  bytes: number;
}

interface Span {
  start: number;
  end: number;
}

export interface MainHeaderPiece extends Span {
  kind: "mainHeader";
}
export interface DbHeaderPiece extends Span {
  kind: "dbHeader";
  slot: 0 | 1;
  header: DatabaseHeader;
  active: boolean;
}
export interface SegmentPiece extends Span {
  kind: "segment" | "validity";
  chunk: Chunk;
  segment: Segment;
  block: number;
  /** First row in the table, counting from the first row group. */
  firstRow: number;
  /**
   * How the end is known: the next segment's start, the block's last non-zero byte, or only the block's end
   * (when measuring was skipped), which is an upper bound.
   */
  extent: "next" | "measured" | "blockEnd";
  /** Segments sharing this block, itself included. */
  shared: number;
}
export interface OverflowPiece extends Span {
  kind: "overflow";
  chunk: Chunk;
  segment: Segment;
  block: number;
}
export interface MetadataPiece extends Span {
  kind: "metadata" | "metadataFree";
  block: number;
  /** Sub-blocks `from`..`to` (inclusive) of this block. */
  from: number;
  to: number;
}
export interface BlockPiece extends Span {
  kind: "free" | "unknown";
  block: number;
}
export interface TailPiece extends Span {
  kind: "tail";
}
/** Zeros after a block's last segment. */
export interface SlackPiece extends Span {
  kind: "slack";
  block: number;
}

export type Piece =
  MainHeaderPiece | DbHeaderPiece | SegmentPiece | OverflowPiece | MetadataPiece | BlockPiece | TailPiece | SlackPiece;
export type PieceKind = Piece["kind"];

export interface DuckDBModel {
  name: string;
  fileSize: number;
  file: FileHeader;
  header: DatabaseHeader;
  engineVersion: string;
  tables: TableInfo[];
  leaves: Leaf[];
  views: CatalogEntry[];
  indexes: CatalogEntry[];
  sequences: CatalogEntry[];
  /** Every byte range we can place, sorted by offset. */
  pieces: Piece[];
  blocks: { total: number; free: number[]; metadata: number[]; unknown: number[] };
  /** Null when the free list couldn't be read, so free and index blocks can't be told apart. */
  usage: BlockUsage | null;
  /** Compressed bytes per leaf column. */
  leafBytes: number[];
  walSize: number | null;
}

export function buildModel(input: {
  name: string;
  fileSize: number;
  file: FileHeader;
  usage: BlockUsage | null;
  catalog: Catalog;
  engineVersion: string;
  walSize: number | null;
  /** Payload bytes in use per block, from `measureBlocks`. */
  used?: Map<number, number>;
}): DuckDBModel {
  const { name, fileSize, file, usage, catalog } = input;
  const header = activeHeader(file);
  const payload = header.blockAllocSize - BLOCK_HEADER_SIZE;
  const pieces: Piece[] = [{ kind: "mainHeader", start: 0, end: HEADER_SIZE }];
  file.headers.forEach((h, slot) => {
    pieces.push({
      kind: "dbHeader",
      start: h.offset,
      end: h.offset + HEADER_SIZE,
      slot: slot as 0 | 1,
      header: h,
      active: slot === file.active,
    });
  });

  const singleMain = catalog.tables.length === 1 && catalog.tables[0]?.schema === "main";
  const leaves: Leaf[] = [];
  /** Segment offsets per block, sized once every table is placed. */
  const inBlock = new Map<number, SegmentPiece[]>();
  const claimed = new Set<number>();

  const tables = catalog.tables.map((def, index): TableInfo => {
    const qualified = `${def.schema}.${def.name}`;
    const tableLeaves = def.columns.map((c, column) => {
      leaves.push({
        table: index,
        column,
        name: c.name,
        type: c.type,
        path: singleMain ? c.name : `${qualified}.${c.name}`,
      });
      return leaves.length - 1;
    });
    const byGroup = new Map<number, StorageRow[]>();
    for (const row of catalog.storage[index] ?? []) {
      const list = byGroup.get(row.rowGroup) ?? [];
      list.push(row);
      byGroup.set(row.rowGroup, list);
    }

    let firstRow = 0;
    const rowGroups = [...byGroup.keys()]
      .sort((a, b) => a - b)
      .map((rg): RowGroupInfo => {
        const rows = byGroup.get(rg) ?? [];
        const numRows = Math.max(
          0,
          ...def.columns.map((_, column) =>
            rows.filter((r) => r.columnId === column && r.path.length === 1).reduce((sum, r) => sum + r.count, 0),
          ),
        );
        const group: RowGroupInfo = { table: index, rg, firstRow, numRows, chunks: [], bytes: 0, blocks: [] };
        group.chunks = def.columns.map((c, column): Chunk => {
          const chunk: Chunk = {
            table: index,
            rg,
            leaf: tableLeaves[column] ?? -1,
            segments: [],
            parts: [],
            bytes: 0,
            bounds: null,
            hasNull: null,
            compressions: [],
          };
          const own = rows
            .filter((r) => r.columnId === column)
            .sort((a, b) => a.path.length - b.path.length || comparePaths(a.path, b.path) || a.start - b.start);
          for (const row of own) {
            const validity = row.segmentType === "VALIDITY";
            const segment: Segment = { row, stats: parseStats(row.stats, c.type), validity, piece: null };
            chunk.segments.push(segment);
            if (row.blockId < 0 || !row.persistent) continue;
            const start = blockStart(header, row.blockId) + BLOCK_HEADER_SIZE + row.blockOffset;
            const piece: SegmentPiece = {
              kind: validity ? "validity" : "segment",
              start,
              end: start,
              chunk,
              segment,
              block: row.blockId,
              firstRow: firstRow + row.start,
              extent: "next",
              shared: 1,
            };
            segment.piece = piece;
            const list = inBlock.get(row.blockId) ?? [];
            list.push(piece);
            inBlock.set(row.blockId, list);
            claimed.add(row.blockId);
            chunk.parts.push(piece);
            for (const block of row.additionalBlocks) {
              const at = blockStart(header, block);
              const overflow: OverflowPiece = {
                kind: "overflow",
                start: at + BLOCK_HEADER_SIZE,
                end: at + header.blockAllocSize,
                chunk,
                segment,
                block,
              };
              claimed.add(block);
              chunk.parts.push(overflow);
              pieces.push(overflow);
            }
          }
          const values = chunk.segments.filter((s) => s.row.path.length === 1 && !s.validity);
          chunk.bounds = mergeBounds(values.map((s) => s.stats.bounds));
          const nulls = chunk.segments.map((s) => s.stats.hasNull).filter((n) => n !== null);
          chunk.hasNull = nulls.length ? nulls.some(Boolean) : null;
          chunk.compressions = [...new Set(chunk.segments.filter((s) => !s.validity).map((s) => s.row.compression))];
          return chunk;
        });
        firstRow += numRows;
        return group;
      });
    return { index, def, qualified, leaves: tableLeaves, rowGroups, bytes: 0 };
  });

  for (const [block, list] of inBlock) {
    list.sort((a, b) => a.start - b.start);
    const payloadStart = blockStart(header, block) + BLOCK_HEADER_SIZE;
    const end = payloadStart + payload;
    const used = input.used?.get(block);
    list.forEach((piece, i) => {
      const next = list[i + 1];
      piece.shared = list.length;
      pieces.push(piece);
      if (next) {
        piece.end = next.start;
      } else if (used === undefined) {
        piece.end = end;
        piece.extent = "blockEnd";
      } else {
        piece.end = Math.max(piece.start + 1, payloadStart + used);
        piece.extent = "measured";
        if (piece.end < end) pieces.push({ kind: "slack", start: piece.end, end, block });
      }
    });
  }

  const metadata: number[] = [];
  const subSize = metadataSubBlockSize(header);
  for (const { block, freeSubBlocks } of catalog.metadata) {
    metadata.push(block);
    claimed.add(block);
    const free = new Set(freeSubBlocks);
    const base = blockStart(header, block) + BLOCK_HEADER_SIZE;
    let from = 0;
    for (let sub = 1; sub <= METADATA_BLOCK_COUNT; sub++) {
      if (sub < METADATA_BLOCK_COUNT && free.has(sub) === free.has(from)) continue;
      const kind = free.has(from) ? "metadataFree" : "metadata";
      const end = sub === METADATA_BLOCK_COUNT ? base + payload : base + sub * subSize;
      pieces.push({ kind, start: base + from * subSize, end, block, from, to: sub - 1 });
      from = sub;
    }
  }

  const freeBlocks = usage?.free.filter((b) => !claimed.has(b)) ?? [];
  const free = new Set(freeBlocks);
  const unknown: number[] = [];
  for (let block = 0; block < header.blockCount; block++) {
    if (claimed.has(block)) continue;
    const start = blockStart(header, block);
    const kind = free.has(block) ? "free" : "unknown";
    if (kind === "unknown") unknown.push(block);
    pieces.push({ kind, start, end: start + header.blockAllocSize, block });
  }
  const blocksEnd = blockStart(header, header.blockCount);
  if (fileSize > blocksEnd) pieces.push({ kind: "tail", start: blocksEnd, end: fileSize });

  pieces.sort((a, b) => a.start - b.start);
  for (const table of tables) {
    for (const group of table.rowGroups) {
      const blocks = new Set<number>();
      for (const chunk of group.chunks) {
        chunk.bytes = chunk.parts.reduce((sum, p) => sum + (p.end - p.start), 0);
        for (const p of chunk.parts) blocks.add(p.block);
      }
      group.bytes = group.chunks.reduce((sum, c) => sum + c.bytes, 0);
      group.blocks = [...blocks].sort((a, b) => a - b);
    }
    table.bytes = table.rowGroups.reduce((sum, g) => sum + g.bytes, 0);
  }
  const leafBytes = leaves.map(
    (leaf) => tables[leaf.table]?.rowGroups.reduce((sum, g) => sum + (g.chunks[leaf.column]?.bytes ?? 0), 0) ?? 0,
  );

  return {
    name,
    fileSize,
    file,
    header,
    engineVersion: input.engineVersion,
    tables,
    leaves,
    views: catalog.views,
    indexes: catalog.indexes,
    sequences: catalog.sequences,
    pieces,
    blocks: { total: header.blockCount, free: freeBlocks, metadata, unknown },
    usage,
    leafBytes,
    walSize: input.walSize,
  };
}

function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return a.length - b.length;
}

export function leafAt(leaves: Leaf[], leaf: number): Leaf {
  const found = leaves[leaf];
  if (!found) throw new Error(`no leaf column ${leaf}`);
  return found;
}

export function chunkAt(group: RowGroupInfo, column: number): Chunk {
  const found = group.chunks[column];
  if (!found) throw new Error(`row group ${group.rg} has no column ${column}`);
  return found;
}

/** Bytes from the first block on, where the tables and metadata live. */
export function blocksRegion(model: DuckDBModel): { from: number; to: number } {
  return { from: BLOCKS_START, to: Math.max(model.fileSize, BLOCKS_START + 1) };
}

/** A path element as DuckDB's column tree would name it: validity, or the nth child. */
export function segmentLabel(s: Segment): string {
  const path = s.row.path;
  if (path.length === 1) return "values";
  if (s.validity) return path.length === 2 ? "validity" : `child ${path.slice(1, -1).join(".")} validity`;
  return `child ${path.slice(1).join(".")}`;
}
