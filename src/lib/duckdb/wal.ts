/**
 * Reads DuckDB's write-ahead log: a version header, then entries framed as `size u64, checksum u64, payload`.
 * This file splits the log into entries and works out which can be trusted; `walEntries.ts` decodes payloads.
 */
import { checksum } from "./checksum";
import { Reader, Truncated, Unsupported } from "./serialization/reader";
import type { ChunkView } from "./serialization/values";
import { category, decodePayload, ENCRYPTED_VERSION, WAL_TYPES, WalType, type Category } from "./walEntries";

export { MAX_ROWS } from "./serialization/values";

const FRAME_HEADER = 16;
const fmt = (n: number) => n.toLocaleString("en-US");

export interface WalEntry {
  index: number;
  /** File offset of the frame (or of the header, for the version entry). */
  start: number;
  end: number;
  /** Where the serialized payload starts and ends; the end is cut short when the file is. */
  payloadStart: number;
  payloadEnd: number;
  /** -1 for bytes that aren't a readable entry. */
  type: number;
  typeName: string;
  category: Category;
  /** Transaction number, counting commits from 1; entries after the last commit share the next number. */
  txn: number;
  /** Why the entry can't be trusted as a whole, e.g. cut off or never committed. Empty when complete. */
  problems: string[];
  summary: string;
  /** `schema.table` that data entries apply to, from the USE_TABLE before them. */
  table: string | null;
}

export interface WalFile {
  name: string;
  size: number;
  /** Bytes read; less than `size` when the log is larger than what was fetched. */
  read: number;
  bytes: Uint8Array;
  version: number | null;
  checkpointIteration: number | null;
  encrypted: boolean;
  entries: WalEntry[];
  commits: number;
  /** Notes about the file as a whole, e.g. that it belongs to another checkpoint. */
  notes: string[];
  /** Column names per `schema.table`, from the database and from CREATE TABLE entries in the log. */
  tables: Map<string, string[]>;
}

export interface WalDetail {
  fields: [string, string][];
  sql: string | null;
  chunk: ChunkView | null;
  /** Set when decoding stopped early, saying where and why. */
  stopped: string | null;
}

export interface WalOptions {
  name: string;
  /** Full size of the log; more than `bytes.length` when only its start was read. */
  size?: number;
  /** Column names per `schema.table`, e.g. from the database's catalog. */
  tables?: Map<string, string[]>;
  /** The database's checkpoint iteration, to tell whether the log belongs to it. */
  checkpointIteration?: number;
}

export const isIncomplete = (entry: WalEntry) => entry.problems.length > 0;

/** Splits a WAL into entries and works out which are complete. Data entries are only counted here. */
export function parseWal(bytes: Uint8Array, options: WalOptions): WalFile {
  const size = options.size ?? bytes.length;
  const partial = bytes.length < size;
  const tables = new Map(options.tables);
  const file: WalFile = {
    name: options.name,
    size,
    read: bytes.length,
    bytes,
    version: null,
    checkpointIteration: null,
    encrypted: false,
    entries: [],
    commits: 0,
    notes: [],
    tables,
  };
  if (!bytes.length) return file;

  const push = (entry: Omit<WalEntry, "index" | "txn" | "category" | "typeName">) =>
    file.entries.push({
      ...entry,
      index: file.entries.length,
      txn: 0,
      category: category(entry.type),
      typeName: WAL_TYPES[entry.type] ?? (entry.type < 0 ? "UNREADABLE" : `TYPE_${entry.type}`),
    });
  /** Bytes that aren't a readable entry, from `start` to the end of what was read. */
  const unreadable = (start: number, summary: string, problem: string) =>
    push({
      start,
      end: bytes.length,
      payloadStart: start,
      payloadEnd: bytes.length,
      type: -1,
      problems: [problem],
      summary,
      table: null,
    });

  // The version entry is written without a frame, so its end is where its object closes.
  let pos: number;
  try {
    const header = new Reader(bytes, 0, bytes.length);
    header.expect(100, "wal_type");
    if (header.uint() !== WalType.VERSION) throw new Unsupported("no version entry");
    header.expect(101, "version");
    file.version = header.uint();
    if (header.field(102)) header.list(() => header.uint());
    file.checkpointIteration = header.opt(103, () => header.uint(), null);
    header.close("the version entry");
    pos = header.pos;
  } catch (error) {
    if (!(error instanceof Truncated || error instanceof Unsupported)) throw error;
    file.notes.push(`This doesn't start like a DuckDB WAL (${error.message}).`);
    unreadable(0, "Unreadable bytes", "unreadable: no WAL version header");
    return file;
  }
  const context = { table: null as string | null, tables };
  push({
    start: 0,
    end: pos,
    payloadStart: 0,
    payloadEnd: pos,
    type: WalType.VERSION,
    problems: [],
    summary: decodePayload(bytes, 0, pos, context, false).summary,
    table: null,
  });

  if (file.version === ENCRYPTED_VERSION) {
    file.encrypted = true;
    file.notes.push("The log is encrypted, so its entries can't be read without the database key.");
    return file;
  }
  const expected = options.checkpointIteration;
  if (file.checkpointIteration !== null && expected !== undefined && file.checkpointIteration !== expected) {
    file.notes.push(
      `The log was written after checkpoint ${file.checkpointIteration}, but the database is at checkpoint ${expected}; DuckDB won't replay it.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos < bytes.length) {
    const start = pos;
    if (bytes.length - pos < FRAME_HEADER) {
      if (!partial) {
        unreadable(
          start,
          "Torn entry header",
          `truncated: ${bytes.length - pos} bytes, fewer than an entry's 16-byte size and checksum`,
        );
      }
      break;
    }
    const length = Number(view.getBigUint64(pos, true));
    const stored = view.getBigUint64(pos + 8, true);
    const payloadStart = pos + FRAME_HEADER;
    const fullEnd = payloadStart + length;
    // An entry cut off by the read limit isn't damaged; it just wasn't read.
    if (fullEnd > bytes.length && partial) break;
    const payloadEnd = Math.min(fullEnd, bytes.length);
    const problems: string[] = [];
    if (fullEnd > bytes.length) {
      problems.push(
        `truncated: the entry is ${fmt(length)} bytes but only ${fmt(bytes.length - payloadStart)} are in the file`,
      );
    } else if (checksum(bytes.subarray(payloadStart, fullEnd)) !== stored) {
      problems.push("checksum mismatch: the entry was only partly written or has been corrupted");
    }
    const decoded = decodePayload(bytes, payloadStart, payloadEnd, context, false);
    if (decoded.type === WalType.USE_TABLE && decoded.table) context.table = decoded.table;
    if (decoded.table && decoded.columns && !problems.length) tables.set(decoded.table, decoded.columns);
    push({
      start,
      end: payloadEnd,
      payloadStart,
      payloadEnd,
      type: decoded.type,
      problems,
      summary: decoded.summary || "Unreadable entry",
      table: category(decoded.type) === "data" ? context.table : (decoded.table ?? null),
    });
    pos = payloadEnd;
    // DuckDB stops replaying at the first entry it can't trust; so do we.
    if (problems.length) {
      if (pos < bytes.length) {
        unreadable(
          pos,
          `${fmt(bytes.length - pos)} bytes after the damaged entry`,
          "after a damaged entry, so DuckDB never reads it",
        );
      }
      break;
    }
  }
  if (partial) {
    file.notes.push(
      `Only the first ${fmt(bytes.length)} of ${fmt(size)} bytes were read; later entries aren't listed.`,
    );
  }

  // Transactions end at each commit; entries after the last one are discarded on replay, unless a commit may
  // still follow in the part of the log that wasn't read.
  let lastCommit = -1;
  for (const [i, entry] of file.entries.entries()) {
    entry.txn = file.commits + 1;
    if (entry.type === WalType.FLUSH && !isIncomplete(entry)) {
      file.commits += 1;
      lastCommit = i;
    }
  }
  if (!partial) {
    for (const entry of file.entries.slice(lastCommit + 1)) {
      if (entry.type !== WalType.VERSION) {
        entry.problems.push("not committed: no COMMIT follows it, so DuckDB discards it on replay");
      }
    }
  }
  return file;
}

/** Everything an entry holds, including up to MAX_ROWS rows for data entries. */
export function decodeEntry(file: WalFile, entry: WalEntry): WalDetail {
  if (entry.type < 0) return { fields: [], sql: null, chunk: null, stopped: null };
  const context = { table: entry.table, tables: file.tables };
  const { fields, sql, chunk, stopped } = decodePayload(
    file.bytes,
    entry.payloadStart,
    entry.payloadEnd,
    context,
    true,
  );
  return { fields, sql, chunk, stopped };
}
