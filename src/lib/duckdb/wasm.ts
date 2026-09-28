import * as duckdb from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import { plainRows, quoteIdent, quoteLiteral, type Engine } from "./engine";
import type { Origin } from "./source";

let engine: Promise<Engine> | null = null;

/** DuckDB-Wasm in a worker, started on first use and shared by every file opened afterwards. */
export function browserEngine(): Promise<Engine> {
  engine ??= start().catch((error: unknown) => {
    engine = null;
    throw error;
  });
  return engine;
}

async function start(): Promise<Engine> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  if (!bundle.mainWorker) throw new Error("no DuckDB-Wasm worker for this browser");
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // Read remote files block by block; a full download of a multi-GB database would not fit in Wasm memory.
  await db.open({ filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false } });
  const conn = await db.connect();
  const query = async (sql: string) => plainRows(await conn.query(sql));
  const [row] = await query("SELECT version() AS v");

  return {
    version: String(row?.v ?? "unknown"),
    query,
    async attach(name: string, origin: Origin, alias: string) {
      if (origin.kind === "file") {
        await db.registerFileHandle(name, origin.file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
      } else if (origin.kind === "url") {
        await db.registerFileURL(name, origin.url, duckdb.DuckDBDataProtocol.HTTP, false);
      } else {
        await db.registerFileBuffer(name, origin.bytes);
      }
      // Unregistered files are fetched relative to the worker, and servers with a SPA fallback answer a missing
      // `.wal` with index.html, which DuckDB then tries to replay. The layout shown is the checkpointed file anyway.
      await db.registerFileBuffer(`${name}.wal`, new Uint8Array(0));
      await query(`ATTACH ${quoteLiteral(name)} AS ${quoteIdent(alias)} (READ_ONLY)`);
    },
    async detach(name: string, alias: string) {
      await query(`DETACH DATABASE IF EXISTS ${quoteIdent(alias)}`);
      await db.dropFile(name);
      await db.dropFile(`${name}.wal`);
    },
  };
}
