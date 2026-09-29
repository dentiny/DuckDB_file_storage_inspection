import { BLOCKS_START } from "./header";

/** Local paths are served by the dev and preview servers under this prefix (see `server/local-files.ts`). */
export const LOCAL_PREFIX = "/@local";
/** Header the local file server sets to the size of the database's `.wal`, or 0 when there is none. */
export const WAL_HEADER = "x-duckdb-wal-size";

/** Where the database bytes come from, which decides how DuckDB-Wasm is told to open it. */
export type Origin =
  { kind: "file"; file: File } | { kind: "url"; url: string } | { kind: "buffer"; bytes: Uint8Array };

/** Logs bigger than this are read only this far; DuckDB checkpoints at 16 MB by default. */
export const MAX_WAL_BYTES = 128 * 1024 * 1024;

export interface WalBytes {
  name: string;
  bytes: Uint8Array;
  /** Full size of the log, which is more than `bytes.length` when it was cut at MAX_WAL_BYTES. */
  size: number;
}

/** A readable database file whose headers were already fetched. */
export interface Source {
  name: string;
  byteLength: number;
  /** The first 12 KB: main header and both database headers. */
  head: ArrayBuffer;
  /** Bytes in the write-ahead log next to the file; null when there is no way to tell. */
  walSize: number | null;
  origin: Origin;
  read(start: number, end: number): Promise<ArrayBuffer>;
  /** The `.wal` next to the database, or null when there is none or it can't be reached. */
  readWal(): Promise<WalBytes | null>;
}

/** Whether the input names a file on this machine rather than a URL. */
const isLocalPath = (input: string) => /^(\/|~\/|\.\.?\/|file:\/\/)/.test(input.trim());

/** The full size from a 206 response's Content-Range, or `fallback` when the server sent the whole file. */
function totalSize(res: Response, fallback: number): number {
  const total = res.headers.get("content-range")?.match(/\/(\d+)$/);
  return res.status === 206 && total ? Number(total[1]) : fallback;
}

/**
 * Turns a local path into a URL on the local file server, and relative URLs into absolute ones: DuckDB-Wasm fetches
 * from its worker, where a relative URL would resolve against the worker script.
 */
export function resolveInput(input: string, base: string): string {
  const s = input.trim();
  if (!isLocalPath(s)) return new URL(s, base).href;
  const path = s.replace(/^file:\/\//, "");
  return new URL(`${LOCAL_PREFIX}?path=${encodeURIComponent(path)}`, base).href;
}

/** Where the database's write-ahead log would be: the same URL, or local path, with `.wal` appended. */
function walUrl(url: string): string {
  const u = new URL(url);
  const path = u.searchParams.get("path");
  if (u.pathname === LOCAL_PREFIX && path) u.searchParams.set("path", `${path}.wal`);
  else u.pathname += ".wal";
  return u.href;
}

/** Every WAL starts with its version entry, whose first field id is 100. */
function looksLikeWal(bytes: Uint8Array): boolean {
  return bytes.length === 0 || (bytes[0] === 0x64 && bytes[1] === 0x00);
}

/** Reads a write-ahead log at `url`, or returns null when there is none there. */
export async function fetchWal(url: string, name: string): Promise<WalBytes | null> {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${MAX_WAL_BYTES - 1}` } });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Static hosts often answer a missing file with their index page.
    if (res.headers.get("content-type")?.includes("text/html") || !looksLikeWal(bytes)) return null;
    return { name, bytes, size: totalSize(res, bytes.length) };
  } catch {
    return null;
  }
}

/** A write-ahead log picked in the browser, read up to MAX_WAL_BYTES. */
export async function walFromFile(file: File): Promise<WalBytes> {
  const bytes = new Uint8Array(await file.slice(0, MAX_WAL_BYTES).arrayBuffer());
  return { name: file.name, bytes, size: file.size };
}

export function nameOf(input: string): string {
  const s = input.trim().replace(/[?#].*$/, "");
  return s.split("/").filter(Boolean).pop() ?? s;
}

export async function urlSource(url: string, name = nameOf(url)): Promise<Source> {
  const fetchRange = async (start: number, end: number) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")) || res.statusText}`.trim());
    return res;
  };
  const read = async (start: number, end: number) => (await fetchRange(start, end)).arrayBuffer();
  const res = await fetchRange(0, BLOCKS_START);
  const head = await res.arrayBuffer();
  // A 200 means the server ignored Range and sent the whole file, which is then read from memory.
  const whole = res.status !== 206;
  const wal = res.headers.get(WAL_HEADER);
  const walSize = wal === null ? null : Number(wal);
  return {
    name,
    byteLength: totalSize(res, head.byteLength),
    head: head.slice(0, BLOCKS_START),
    walSize,
    origin: whole ? { kind: "buffer", bytes: new Uint8Array(head) } : { kind: "url", url },
    read: whole ? async (start, end) => head.slice(start, end) : read,
    readWal: async () => (walSize === 0 ? null : fetchWal(walUrl(url), `${name}.wal`)),
  };
}

/** A database picked in the browser, with its `.wal` if it was picked too; browsers can't see sibling files. */
export async function fileSource(file: File, wal?: File): Promise<Source> {
  const read = (start: number, end: number) => file.slice(start, end).arrayBuffer();
  return {
    name: file.name,
    byteLength: file.size,
    head: await read(0, BLOCKS_START),
    walSize: wal ? wal.size : null,
    origin: { kind: "file", file },
    read,
    readWal: async () => (wal ? walFromFile(wal) : null),
  };
}
