import { readCatalog } from "./catalog";
import { measureBlocks } from "./extent";
import type { Engine } from "./engine";
import { activeHeader, NotDuckDBError, parseHeaders, readBlockUsage, type BlockUsage } from "./header";
import { buildModel, type DuckDBModel } from "./model";
import type { Source, WalBytes } from "./source";
import { parseWal, type WalFile } from "./wal";

let attachments = 0;

/** Parses the headers and free list itself, then asks DuckDB for the catalog and where every segment lives. */
export async function loadDuckDB(source: Source, engine: Engine): Promise<DuckDBModel> {
  const file = parseHeaders(source.head);
  if (file.encrypted) throw new Error("the database is encrypted, so its blocks can't be read without the key");
  let usage: BlockUsage | null = null;
  try {
    usage = await readBlockUsage(file, source.read);
  } catch (error) {
    console.warn("couldn't read the free list", error);
  }

  const id = ++attachments;
  const name = `inspect_${id}.duckdb`;
  const alias = `inspect_${id}`;
  await engine.attach(name, source.origin, alias);
  try {
    const catalog = await readCatalog(engine, alias);
    const used = await measureBlocks(activeHeader(file), catalog.storage, usage, source.read);
    return buildModel({
      name: source.name,
      fileSize: source.byteLength,
      file,
      usage,
      catalog,
      engineVersion: engine.version,
      walSize: source.walSize,
      used,
    });
  } finally {
    await engine.detach(name, alias).catch((error: unknown) => console.warn("couldn't detach", error));
  }
}

/** Parses a write-ahead log against the database it belongs to, which supplies column names and the checkpoint. */
export function walFor(wal: WalBytes, model: DuckDBModel): WalFile {
  const tables = new Map(model.tables.map((t) => [t.qualified, t.def.columns.map((c) => c.name)]));
  return parseWal(wal.bytes, {
    name: wal.name,
    size: wal.size,
    tables,
    checkpointIteration: model.header.iteration,
  });
}

export async function loadWal(source: Source, model: DuckDBModel): Promise<WalFile | null> {
  const wal = await source.readWal();
  return wal ? walFor(wal, model) : null;
}

/** A sentence saying why a file couldn't be read, for the status line. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NotDuckDBError) return `this doesn't look like a DuckDB database (${message}).`;
  if (error instanceof TypeError && /fetch/i.test(message)) {
    return "the request was blocked. Check the URL, and that the server allows cross-origin (CORS) range requests.";
  }
  if (/newer version of DuckDB|storage version/i.test(message)) {
    return `it was written by a DuckDB this viewer can't read yet (${message}).`;
  }
  return message;
}
