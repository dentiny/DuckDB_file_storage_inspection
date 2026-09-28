import * as duckdb from "@duckdb/duckdb-wasm/blocking";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { plainRows, quoteIdent, quoteLiteral, type Engine } from "../src/lib/duckdb/engine";
import { loadDuckDB } from "../src/lib/duckdb/load";
import type { DuckDBModel } from "../src/lib/duckdb/model";
import { bufferSource } from "../src/lib/duckdb/source";

let engine: Promise<Engine> | null = null;

/** The same DuckDB-Wasm build the browser runs, in its synchronous Node flavor. */
export function nodeEngine(): Promise<Engine> {
  engine ??= (async () => {
    const dist = path.dirname(createRequire(import.meta.url).resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"));
    const bundles = {
      mvp: { mainModule: path.join(dist, "duckdb-mvp.wasm"), mainWorker: "" },
      eh: { mainModule: path.join(dist, "duckdb-eh.wasm"), mainWorker: "" },
    };
    const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({});
    const conn = db.connect();
    const query = async (sql: string) => plainRows(conn.query(sql));
    const [row] = await query("SELECT version() AS v");
    return {
      version: String(row?.v),
      query,
      async attach(name, origin, alias) {
        if (origin.kind !== "buffer") throw new Error("tests attach buffers only");
        db.registerFileBuffer(name, origin.bytes);
        db.registerFileBuffer(`${name}.wal`, new Uint8Array(0));
        await query(`ATTACH ${quoteLiteral(name)} AS ${quoteIdent(alias)} (READ_ONLY)`);
      },
      async detach(name, alias) {
        await query(`DETACH DATABASE IF EXISTS ${quoteIdent(alias)}`);
        db.dropFile(name);
        db.dropFile(`${name}.wal`);
      },
    };
  })();
  return engine;
}

export async function loadFixture(file: string): Promise<DuckDBModel> {
  const bytes = new Uint8Array(await readFile(file));
  return loadDuckDB(bufferSource(path.basename(file), bytes), await nodeEngine());
}
