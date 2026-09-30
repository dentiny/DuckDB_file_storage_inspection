import { formatBytes, formatNumber } from "../format";
import { readCatalog, type Catalog } from "./catalog";
import { measureBlocks } from "./extent";
import type { Engine } from "./engine";
import {
  activeHeader,
  BLOCKS_START,
  blockStart,
  NotDuckDBError,
  parseHeaders,
  readBlockUsage,
  readChain,
  type BlockUsage,
} from "./header";
import { buildModel, type DuckDBModel, type HeaderChains } from "./model";
import type { Source, WalBytes } from "./source";
import { parseWal, type WalFile } from "./wal";

let attachments = 0;

const EMPTY_CATALOG: Catalog = { tables: [], storage: [], views: [], indexes: [], sequences: [], metadata: [] };

/**
 * Parses the headers and free list itself, then asks DuckDB for the catalog and where every segment lives.
 * When DuckDB can't open the file, e.g. because it was cut off, the headers and block layout are still shown.
 */
export async function loadDuckDB(source: Source, engine: Engine): Promise<DuckDBModel> {
  const file = parseHeaders(source.head);
  if (file.encrypted) throw new Error("the database is encrypted, so its blocks can't be read without the key");
  const header = activeHeader(file);
  const problems: string[] = [];
  const expected = blockStart(header, header.blockCount);
  if (source.byteLength < expected) {
    const present = Math.max(0, Math.floor((source.byteLength - BLOCKS_START) / header.blockAllocSize));
    problems.push(
      `The file is cut off: its header counts ${formatNumber(header.blockCount)} blocks (${formatBytes(expected)}), but the file ends after ${formatBytes(source.byteLength)}, ${formatNumber(present)} whole blocks in. A process died while the file grew, or a copy was interrupted.`,
    );
  }
  let usage: BlockUsage | null = null;
  try {
    usage = await readBlockUsage(file, source.read);
  } catch (error) {
    console.warn("couldn't read the free list", error);
  }
  if (!header.checksumOk) {
    problems.push(
      "The active database header fails its checksum: it was torn mid-write or corrupted, so DuckDB won't trust it.",
    );
  }
  // Both headers' pointers: the previous one's show where the last checkpoint's metadata was.
  const chains: HeaderChains[] = await Promise.all(
    file.headers.map(async (h) => ({
      catalog: h.metaBlock ? await readChain(h, source.read, h.metaBlock, source.byteLength) : null,
      freeList: h.freeList ? await readChain(h, source.read, h.freeList, source.byteLength) : null,
    })),
  );

  const id = ++attachments;
  const name = `inspect_${id}.duckdb`;
  const alias = `inspect_${id}`;
  let catalog = EMPTY_CATALOG;
  let used: Map<number, number> | undefined;
  let opened = true;
  try {
    await engine.attach(name, source.origin, alias);
    catalog = await readCatalog(engine, alias);
    used = await measureBlocks(header, catalog.storage, usage, source.read);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opened = false;
    problems.push(
      `DuckDB couldn't open it (${message}), so tables and segments aren't shown. The headers and block layout come from reading the file directly.`,
    );
  } finally {
    await engine.detach(name, alias).catch((error: unknown) => console.warn("couldn't detach", error));
  }
  return buildModel({
    name: source.name,
    fileSize: source.byteLength,
    file,
    usage,
    catalog,
    engineVersion: engine.version,
    walSize: source.walSize,
    used,
    problems,
    opened,
    chains,
  });
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
  if (error instanceof NotDuckDBError) {
    return message.startsWith("the file is cut off")
      ? `${message}.`
      : `this doesn't look like a DuckDB database (${message}).`;
  }
  if (error instanceof TypeError && /fetch/i.test(message)) {
    return "couldn't reach the viewer's server. Is `npm start` still running? Restart it and reload the page.";
  }
  if (/newer version of DuckDB|storage version/i.test(message)) {
    return `it was written by a DuckDB this viewer can't read yet (${message}).`;
  }
  return message;
}
