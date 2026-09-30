import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import { LOCAL_PREFIX, PICK_ROUTE, WAL_HEADER } from "../src/lib/duckdb/localRoute.ts";
import { pickFile } from "./pick-file.ts";

/** Resolves `~` and relative paths against the directory the server was started in. */
function resolveLocalPath(raw: string, cwd = process.cwd()): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(homedir(), raw.slice(1)) : raw;
  return path.resolve(cwd, expanded);
}

/** `length` bytes of `file` from `offset`; fewer when the file is shorter, none when it can't be read. */
async function readBytes(file: string, offset: number, length: number): Promise<Buffer> {
  try {
    const handle = await open(file, "r");
    try {
      const out = Buffer.alloc(length);
      const { bytesRead } = await handle.read(out, 0, length, offset);
      return out.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return Buffer.alloc(0);
  }
}

const isDuckDB = async (file: string) => (await readBytes(file, 8, 4)).toString("latin1") === "DUCK";
/** A WAL starts with its version entry, whose first field id is 100. */
const isWal = async (file: string) => (await readBytes(file, 0, 2)).equals(Buffer.from([0x64, 0x00]));

async function walSize(file: string): Promise<number> {
  try {
    return (await stat(`${file}.wal`)).size;
  } catch {
    return 0;
  }
}

function fail(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain");
  res.end(message);
}

/**
 * Serves DuckDB files from this machine by path with HTTP range requests, so DuckDB-Wasm can read one block at a
 * time. Only files that start with DuckDB's magic bytes are served.
 */
async function serveLocalFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const raw = url.searchParams.get("path");
  if (!raw) return fail(res, 400, "missing ?path=");
  const file = resolveLocalPath(raw);
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return fail(res, 400, `${file} is not a file`);
    size = info.size;
  } catch {
    return fail(res, 404, `no file at ${file}`);
  }
  // A write-ahead log has no magic bytes of its own: serve it when its database is a DuckDB file, or when it
  // starts like a WAL, so a log can be inspected without its database.
  const wal = file.endsWith(".wal");
  const database = wal ? file.slice(0, -".wal".length) : file;
  const allowed = (await isDuckDB(database)) || (wal && (await isWal(file)));
  if (!allowed) {
    return fail(
      res,
      415,
      wal ? `${file} isn't a DuckDB write-ahead log` : `${file} doesn't start with DuckDB's magic bytes`,
    );
  }

  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader(WAL_HEADER, String(await walSize(file)));
  res.setHeader("access-control-expose-headers", `content-range, content-length, ${WAL_HEADER}`);

  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = size - 1;
  if (range) {
    const [, from = "", to = ""] = range;
    if (from === "") start = Math.max(0, size - Number(to));
    else {
      start = Number(from);
      if (to !== "") end = Math.min(Number(to), size - 1);
    }
    if (start >= size || start > end) {
      res.setHeader("content-range", `bytes */${size}`);
      return fail(res, 416, "range not satisfiable");
    }
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("content-length", String(end - start + 1));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file, { start, end }).pipe(res);
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/**
 * Whether the request comes from the app on this machine. The route reads files off this disk, so it stays
 * unreachable from other machines even when the server is started with `--host`; checking Host stops DNS
 * rebinding, and checking Origin stops other sites open in the same browser.
 */
function fromThisMachine(req: IncomingMessage): boolean {
  if (!LOOPBACK.test(req.socket.remoteAddress ?? "") || !LOCAL_HOST.test(req.headers.host ?? "")) return false;
  // Pages from other sites open in this machine's browser can send requests here too; only the app's own may.
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function servePick(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "use POST");
  // Unlike reads, a dialog is a side effect a plain <img> or form from another site could trigger without an Origin.
  if (req.headers.origin === undefined) return fail(res, 403, "missing Origin");
  const picked = await pickFile();
  if (picked === undefined) return fail(res, 501, "no file dialog on this system");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(picked === null ? {} : { path: picked }));
}

const middleware: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url === PICK_ROUTE) {
    if (!fromThisMachine(req)) return fail(res, 403, "the file dialog is only shown to this machine");
    servePick(req, res).catch((error: unknown) => fail(res, 500, String(error)));
    return;
  }
  if (!req.url?.startsWith(`${LOCAL_PREFIX}?`)) return next();
  if (!fromThisMachine(req)) return fail(res, 403, "local files are only served to this machine");
  serveLocalFile(req, res).catch((error: unknown) => fail(res, 500, String(error)));
};

/** Adds the local file route to `vite dev` and `vite preview`. It is not part of the static build. */
export function localFiles(): Plugin {
  return {
    name: "duckdb-file-storage-inspection-local-files",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
