import { BLOCKS_START } from "./header";

/** Local paths are served by the dev and preview servers under this prefix (see `server/local-files.ts`). */
export const LOCAL_PREFIX = "/@local";
/** Header the local file server sets to the size of the database's `.wal`, or 0 when there is none. */
export const WAL_HEADER = "x-duckdb-wal-size";

/** Where the database bytes come from, which decides how DuckDB-Wasm is told to open it. */
export type Origin =
  { kind: "file"; file: File } | { kind: "url"; url: string } | { kind: "buffer"; bytes: Uint8Array };

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
}

/** Whether the input names a file on this machine rather than a URL. */
export function isLocalPath(input: string): boolean {
  const s = input.trim();
  return s.startsWith("/") || s.startsWith("~/") || s.startsWith("./") || s.startsWith("../") || /^file:\/\//.test(s);
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
  const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
  // A 200 means the server ignored Range and sent the whole file.
  const byteLength = res.status === 206 && range ? Number(range[1]) : head.byteLength;
  if (res.status !== 206 && head.byteLength > BLOCKS_START) {
    const whole = new Uint8Array(head);
    return {
      name,
      byteLength,
      head: head.slice(0, BLOCKS_START),
      walSize: null,
      origin: { kind: "buffer", bytes: whole },
      read: async (start, end) => head.slice(start, end),
    };
  }
  const wal = res.headers.get(WAL_HEADER);
  return {
    name,
    byteLength,
    head,
    walSize: wal === null ? null : Number(wal),
    origin: { kind: "url", url },
    read,
  };
}

export async function fileSource(file: File): Promise<Source> {
  const read = (start: number, end: number) => file.slice(start, end).arrayBuffer();
  return {
    name: file.name,
    byteLength: file.size,
    head: await read(0, BLOCKS_START),
    walSize: null,
    origin: { kind: "file", file },
    read,
  };
}

export function bufferSource(name: string, bytes: Uint8Array): Source {
  const copy = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const buffer = copy();
  return {
    name,
    byteLength: bytes.byteLength,
    head: buffer.slice(0, BLOCKS_START),
    walSize: null,
    origin: { kind: "buffer", bytes },
    read: async (start, end) => buffer.slice(start, end),
  };
}
