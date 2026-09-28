import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import { LOCAL_PREFIX, WAL_HEADER } from "../src/lib/duckdb/source";

/** Resolves `~` and relative paths against the directory the server was started in. */
export function resolveLocalPath(raw: string, cwd = process.cwd()): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(homedir(), raw.slice(1)) : raw;
  return path.resolve(cwd, expanded);
}

async function isDuckDB(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 8);
    return magic.toString("latin1") === "DUCK";
  } finally {
    await handle.close();
  }
}

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
export async function serveLocalFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  if (!(await isDuckDB(file))) return fail(res, 415, `${file} doesn't start with DuckDB's magic bytes`);

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

const middleware: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith(`${LOCAL_PREFIX}?`)) return next();
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
