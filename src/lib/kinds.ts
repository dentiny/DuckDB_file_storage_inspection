import type { PieceKind } from "./duckdb/model";

interface KindInfo {
  label: string;
  color: string;
  /** What this byte range is for, in one or two sentences. */
  what: string;
}

export const KINDS: Record<PieceKind, KindInfo> = {
  segment: {
    label: "Column segment",
    color: "#c3c8d0",
    what: "Compressed values of one column for a run of rows in one row group. It is the unit DuckDB reads, decompresses and skips by min/max.",
  },
  validity: {
    label: "Validity mask",
    color: "#e2e5ea",
    what: "One bit per row saying whether the value is NULL. Stored next to the values; a column with no NULLs keeps only a constant flag in metadata.",
  },
  overflow: {
    label: "Overflow block",
    color: "#d6c7b4",
    what: "A whole block a segment owns on top of its own, for strings too long to sit in the segment or large dictionaries.",
  },
  metadata: {
    label: "Metadata",
    color: "#4b5563",
    what: "The catalog, every table's row group pointers and each segment's statistics, written as a chain of 4 KB sub-blocks.",
  },
  metadataFree: {
    label: "Free metadata",
    color: "#9ca3af",
    what: "Unused sub-blocks of a metadata block, filled by the next checkpoint.",
  },
  free: {
    label: "Free block",
    color: "#fde68a",
    what: "Released by deletes, drops or rewrites. DuckDB reuses it before growing the file, but the file doesn't shrink.",
  },
  unknown: {
    label: "Other block",
    color: "#f9a8d4",
    what: "In use but not a table segment or metadata: usually ART index storage for a PRIMARY KEY, UNIQUE or CREATE INDEX.",
  },
  missing: {
    label: "Missing block",
    color: "#e5e7eb",
    what: "The header counts this block, but the file ends before it: the file was cut off, e.g. by a crash while it grew or an incomplete copy.",
  },
  unread: {
    label: "Unread block",
    color: "#cbd5e1",
    what: "DuckDB couldn't open the file, so what this block holds isn't known; it isn't on the free list.",
  },
  slack: {
    label: "Unused space",
    color: "#e9ebee",
    what: "Zeros after a block's last segment. DuckDB packs small segments together into shared blocks; the rest of the block stays empty.",
  },
  mainHeader: {
    label: "Main header",
    color: "#94a3b8",
    what: 'Checksum, the "DUCK" magic bytes, the storage format version, and the DuckDB version that created the file.',
  },
  dbHeader: {
    label: "Database header",
    color: "#a5b4fc",
    what: "Points to the metadata and the free list. There are two, and each checkpoint overwrites the older one, so a crash mid-write leaves the other intact.",
  },
  tail: {
    label: "Past the last block",
    color: "#f3f4f6",
    what: "Bytes after the last block the header counts: left when the file wasn't truncated, or blocks a large insert wrote that only the WAL points to until the next checkpoint.",
  },
};
