import type { Origin } from "./source";

export type Row = Record<string, unknown>;

/** A DuckDB that can attach a database file read-only and query its catalog. */
export interface Engine {
  /** e.g. "v1.5.4". */
  version: string;
  /** Makes the database readable as `name` and attaches it as `alias`. */
  attach(name: string, origin: Origin, alias: string): Promise<void>;
  detach(name: string, alias: string): Promise<void>;
  query(sql: string): Promise<Row[]>;
}

/** The query result as plain objects, with lists turned into arrays. */
export function plainRows(table: { toArray(): { toJSON(): Row }[] }): Row[] {
  return table.toArray().map((row) => {
    const out = row.toJSON();
    for (const [key, value] of Object.entries(out)) {
      if (value && typeof value === "object" && "toArray" in value && typeof value.toArray === "function") {
        out[key] = [...(value.toArray() as Iterable<unknown>)];
      }
    }
    return out;
  });
}

export function quoteLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

export function quoteIdent(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}
