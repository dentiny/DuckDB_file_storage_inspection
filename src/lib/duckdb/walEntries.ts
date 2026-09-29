/**
 * Decodes the payload of each kind of WAL entry. Field ids follow DuckDB v1.x's `write_ahead_log.cpp` and
 * `storage/serialization/*.cpp`.
 */
import { readExpression } from "./serialization/expressions";
import { qualified, quoteName, Reader, Truncated, Unsupported } from "./serialization/reader";
import { readType } from "./serialization/types";
import { readChunk, readValue, show, type ChunkView } from "./serialization/values";

export const WAL_TYPES: Record<number, string> = {
  1: "CREATE_TABLE",
  2: "DROP_TABLE",
  3: "CREATE_SCHEMA",
  4: "DROP_SCHEMA",
  5: "CREATE_VIEW",
  6: "DROP_VIEW",
  8: "CREATE_SEQUENCE",
  9: "DROP_SEQUENCE",
  10: "SEQUENCE_VALUE",
  11: "CREATE_MACRO",
  12: "DROP_MACRO",
  13: "CREATE_TYPE",
  14: "DROP_TYPE",
  20: "ALTER_INFO",
  21: "CREATE_TABLE_MACRO",
  22: "DROP_TABLE_MACRO",
  23: "CREATE_INDEX",
  24: "DROP_INDEX",
  25: "USE_TABLE",
  26: "INSERT_TUPLE",
  27: "DELETE_TUPLE",
  28: "UPDATE_TUPLE",
  29: "ROW_GROUP_DATA",
  98: "WAL_VERSION",
  99: "CHECKPOINT",
  100: "WAL_FLUSH",
};

export const WalType = {
  CREATE_SCHEMA: 3,
  DROP_SCHEMA: 4,
  SEQUENCE_VALUE: 10,
  ALTER: 20,
  CREATE_INDEX: 23,
  USE_TABLE: 25,
  INSERT: 26,
  DELETE: 27,
  UPDATE: 28,
  ROW_GROUP_DATA: 29,
  VERSION: 98,
  CHECKPOINT: 99,
  FLUSH: 100,
} as const;

/** Entries that write a catalog entry as a CreateInfo. */
const CREATES = new Set([1, 5, 8, 11, 13, 21]);
/** Entries that drop a catalog entry by schema and name. */
const DROPS = new Set([2, 6, 9, 12, 14, 22, 24]);

export const ENCRYPTED_VERSION = 3;

export type Category = "catalog" | "data" | "commit" | "meta";

const META = new Set<number>([WalType.USE_TABLE, WalType.VERSION, WalType.CHECKPOINT, WalType.SEQUENCE_VALUE]);

export function category(type: number): Category {
  if (type === WalType.FLUSH) return "commit";
  if (type >= WalType.INSERT && type <= WalType.ROW_GROUP_DATA) return "data";
  return META.has(type) ? "meta" : "catalog";
}

export interface Decoded {
  type: number;
  summary: string;
  fields: [string, string][];
  sql: string | null;
  chunk: ChunkView | null;
  /** The table a USE_TABLE or CREATE TABLE names. */
  table?: string;
  /** Column names of a CREATE TABLE, for naming the columns of later inserts. */
  columns?: string[];
  /** Set when decoding stopped early, saying where and why. */
  stopped: string | null;
}

export interface Context {
  /** `schema.table` from the last USE_TABLE, which data entries apply to. */
  table: string | null;
  tables: Map<string, string[]>;
}

/** Ends decoding without a warning where the rest (a view's query, a macro's body) is already in `sql`. */
class QuietStop extends Error {}
const stop = (): never => {
  throw new QuietStop();
};

const plural = (n: number, what: string) => `${n.toLocaleString("en-US")} ${what}${n === 1 ? "" : "s"}`;

const CATALOG_TYPES: Record<number, string> = {
  1: "TABLE",
  2: "SCHEMA",
  3: "VIEW",
  4: "INDEX",
  6: "SEQUENCE",
  8: "TYPE",
  30: "MACRO",
  31: "TABLE MACRO",
};
const ON_CONFLICT = ["error", "ignore", "replace", "alter"];

/** CreateInfo and its subclass, as written for CREATE TABLE/VIEW/SEQUENCE/MACRO/TYPE/INDEX entries. */
function readCreateInfo(r: Reader, out: Decoded): void {
  r.nullable(() =>
    r.object("create info", () => {
      r.expect(100, "catalog type");
      const kind = r.uint();
      const catalog = r.opt(101, () => r.string(), "");
      const schema = r.opt(102, () => r.string(), "") || "main";
      const temporary = r.opt(103, () => r.bool(), false);
      r.opt(104, () => r.bool(), false);
      r.expect(105, "on_conflict");
      const conflict = r.uint();
      out.sql = r.opt(106, () => r.string(), "") || null;
      out.fields.push(["Kind", CATALOG_TYPES[kind] ?? `catalog type ${kind}`]);
      if (catalog) out.fields.push(["Catalog", catalog]);
      out.fields.push(["Schema", schema]);
      if (temporary) out.fields.push(["Temporary", "yes"]);
      if (conflict) out.fields.push(["On conflict", ON_CONFLICT[conflict] ?? String(conflict)]);
      if (r.field(107)) out.fields.push(["Comment", show(readValue(r)) ?? "NULL"]);
      if (r.field(108)) {
        const tags = r.list(() =>
          r.pair(
            () => r.string(),
            () => r.string(),
          ),
        );
        out.fields.push(["Tags", tags.map(([k, v]) => `${k}=${v}`).join(", ")]);
      }
      if (r.field(109)) throw new Unsupported("catalog dependencies");

      const name = r.opt(200, () => r.string(), "");
      const target = qualified(schema, name);
      out.fields.push(["Name", name]);
      out.summary = `CREATE ${CATALOG_TYPES[kind] ?? "ENTRY"} ${target}`;
      switch (kind) {
        case 1:
          return readTable(r, out, target);
        case 6: {
          const usage = r.opt(201, () => r.uint(), 0);
          const [increment, min, max, start] = [202, 203, 204, 205].map((id) => r.opt(id, () => r.svarint(), 0n));
          const cycle = r.opt(206, () => r.bool(), false);
          out.fields.push(
            ["Start", String(start)],
            ["Increment", String(increment)],
            ["Min", String(min)],
            ["Max", String(max)],
          );
          if (usage) out.fields.push(["Used", String(usage)]);
          out.sql ??= `CREATE SEQUENCE ${target} START ${start} INCREMENT ${increment}${cycle ? " CYCLE" : ""};`;
          return;
        }
        case 8: {
          r.expect(201, "type");
          const t = readType(r);
          out.fields.push(["Type", t.name]);
          out.sql ??= `CREATE TYPE ${target} AS ${t.name};`;
          return;
        }
        case 4: {
          const table = r.opt(201, () => r.string(), "");
          out.fields.push(["Table", table]);
          out.summary = `CREATE INDEX ${name} ON ${qualified(schema, table)}`;
          return stop();
        }
        case 3:
        case 30:
        case 31:
          return stop();
        default:
          throw new Unsupported(`CREATE for catalog type ${kind}`);
      }
    }),
  );
}

/** CreateTableInfo after its name: columns, then constraints, rebuilt as a CREATE TABLE statement. */
function readTable(r: Reader, out: Decoded, target: string): void {
  r.expect(201, "columns");
  const columns = r.object("a column list", () =>
    r.opt(
      100,
      () =>
        r.list(() =>
          r.object("a column", () => {
            const name = r.opt(100, () => r.string(), "");
            r.expect(101, "column type");
            const type = readType(r).name;
            const def = r.opt(102, () => r.nullable(() => readExpression(r)), null);
            r.expect(103, "column category");
            const generated = r.uint() === 1;
            r.expect(104, "compression");
            r.uint();
            r.opt(105, () => readValue(r), null);
            r.opt(
              106,
              () =>
                r.list(() =>
                  r.pair(
                    () => r.string(),
                    () => r.string(),
                  ),
                ),
              [],
            );
            return { name, type, def, generated };
          }),
        ),
      [],
    ),
  );
  const names = columns.map((c) => c.name);
  const constraints = r.opt(202, () => r.list(() => r.nullable(() => readConstraint(r, names))), []);
  if (r.field(203)) throw new Unsupported("CREATE TABLE AS queries");

  const notNull = new Set(constraints.filter((c) => typeof c === "number"));
  const lines = columns.map((c, i) => {
    const def = c.def ? (c.generated ? ` GENERATED ALWAYS AS (${c.def})` : ` DEFAULT ${c.def}`) : "";
    return `  ${quoteName(c.name)} ${c.type}${def}${notNull.has(i) ? " NOT NULL" : ""}`;
  });
  for (const c of constraints) if (typeof c === "string") lines.push(`  ${c}`);
  out.table = target;
  out.columns = names;
  out.summary = `CREATE TABLE ${target} (${plural(columns.length, "column")})`;
  out.sql = `CREATE TABLE ${target} (\n${lines.join(",\n")}\n);`;
}

/** A table constraint as SQL, or the column index of a NOT NULL constraint, which belongs on the column. */
function readConstraint(r: Reader, columns: string[]): string | number {
  return r.object("a constraint", () => {
    r.expect(100, "constraint type");
    const type = r.uint();
    switch (type) {
      case 1:
        r.expect(200, "not null column");
        return r.uint();
      case 2:
        return `CHECK ${r.opt(200, () => r.nullable(() => readExpression(r)) ?? "", "")}`;
      case 3: {
        const pk = r.opt(200, () => r.bool(), false);
        r.expect(201, "unique column index");
        const index = r.uint();
        const named = r.opt(202, () => r.list(() => r.string()), []);
        const cols = named.length ? named : columns.slice(index, index + 1);
        return `${pk ? "PRIMARY KEY" : "UNIQUE"} (${cols.map(quoteName).join(", ")})`;
      }
      default:
        throw new Unsupported(`constraint type ${type}`);
    }
  });
}

const ALTER_TYPES: Record<number, string> = {
  1: "TABLE",
  2: "VIEW",
  3: "SEQUENCE",
  4: "OWNERSHIP",
  5: "FUNCTION",
  6: "TABLE FUNCTION",
  7: "COMMENT",
  8: "COLUMN COMMENT",
};
const ALTER_TABLE: Record<number, string> = {
  1: "RENAME COLUMN",
  2: "RENAME TO",
  3: "ADD COLUMN",
  4: "DROP COLUMN",
  5: "ALTER COLUMN TYPE",
  6: "ALTER COLUMN SET DEFAULT",
  7: "FOREIGN KEY",
  8: "ALTER COLUMN SET NOT NULL",
  9: "ALTER COLUMN DROP NOT NULL",
};

/** AlterInfo: what it alters, then for tables the change; renames, adds and drops are rebuilt as SQL. */
function readAlter(r: Reader, out: Decoded): void {
  r.nullable(() =>
    r.object("alter info", () => {
      r.expect(100, "parse info type");
      r.uint();
      r.expect(200, "alter type");
      const kind = r.uint();
      r.opt(201, () => r.string(), "");
      const schema = r.opt(202, () => r.string(), "main");
      const name = r.opt(203, () => r.string(), "");
      r.expect(204, "if_not_found");
      r.uint();
      r.opt(205, () => r.bool(), false);
      const target = qualified(schema, name);
      out.fields.push(["Alters", ALTER_TYPES[kind] ?? `alter type ${kind}`], ["Target", target]);
      out.summary = `ALTER ${ALTER_TYPES[kind] ?? ""} ${target}`;
      if (kind !== 1) return stop();

      r.expect(300, "alter table type");
      const sub = r.uint();
      const action = ALTER_TABLE[sub] ?? `change ${sub}`;
      out.fields.push(["Change", action]);
      const str = (id: number) => r.opt(id, () => r.string(), "");
      let clause: string | null = null;
      if (sub === 1) {
        const from = str(400);
        clause = `RENAME COLUMN ${quoteName(from)} TO ${quoteName(str(401))}`;
      } else if (sub === 2) {
        clause = `RENAME TO ${quoteName(str(400))}`;
      } else if (sub === 3) {
        r.expect(400, "new column");
        const column = str(100);
        r.expect(101, "column type");
        clause = `ADD COLUMN ${quoteName(column)} ${readType(r).name}`;
      } else if (sub === 4) {
        clause = `DROP COLUMN ${quoteName(str(400))}`;
      }
      out.summary = `ALTER TABLE ${target} ${clause ?? action}`;
      if (clause) out.sql = `ALTER TABLE ${target} ${clause};`;
      return stop();
    }),
  );
}

/** A DataChunk's row count and types, read ahead so they survive when the rows themselves are cut off. */
const chunkHead = (r: Reader, names: string[]) => readChunk(r.fork(), false, names);

/**
 * Decodes one entry's payload. With `withData`, data entries also decode every row; without, only their row
 * count and types, which is enough for the entry list.
 */
export function decodePayload(
  bytes: Uint8Array,
  start: number,
  end: number,
  context: Context,
  withData: boolean,
): Decoded {
  const r = new Reader(bytes, start, end);
  const out: Decoded = { type: -1, summary: "", fields: [], sql: null, chunk: null, stopped: null };
  const target = context.table ?? "the current table";
  const names = context.table ? context.tables.get(context.table) : undefined;
  const dropped = () => {
    r.expect(101, "schema");
    const schema = r.string();
    r.expect(102, "name");
    return qualified(schema, r.string());
  };
  try {
    r.expect(100, "wal_type");
    out.type = r.uint();
    const name = WAL_TYPES[out.type] ?? `type ${out.type}`;
    out.summary = name;
    switch (out.type) {
      case WalType.VERSION: {
        r.expect(101, "version");
        const version = r.uint();
        out.fields.push(["Version", String(version)]);
        out.summary = `WAL version ${version}${version === ENCRYPTED_VERSION ? " (encrypted)" : ""}`;
        const id = r.opt(102, () => r.list(() => r.uint()), null);
        if (id) out.fields.push(["Database id", id.map((b) => b.toString(16).padStart(2, "0")).join("")]);
        const iteration = r.opt(103, () => r.uint(), null);
        if (iteration !== null) out.fields.push(["Checkpoint", String(iteration)]);
        break;
      }
      case WalType.CHECKPOINT: {
        r.expect(101, "meta_block");
        const [pointer, offset] = r.object("a block pointer", () => [
          r.opt(100, () => r.uvarint(), 0n),
          r.opt(101, () => r.uint(), 0),
        ]);
        const block = Number(pointer & 0x00ff_ffff_ffff_ffffn);
        out.fields.push(["Metadata", `block ${block} · sub-block ${Number(pointer >> 56n)} · offset ${offset}`]);
        out.summary = `CHECKPOINT to metadata block ${block}`;
        break;
      }
      case WalType.FLUSH:
        out.summary = "COMMIT";
        break;
      case WalType.USE_TABLE: {
        r.expect(101, "schema");
        const schema = r.string();
        r.expect(102, "table");
        out.table = qualified(schema, r.string());
        out.fields.push(["Table", out.table]);
        out.summary = `USE TABLE ${out.table}`;
        break;
      }
      case WalType.INSERT:
      case WalType.DELETE: {
        r.expect(101, "chunk");
        const insert = out.type === WalType.INSERT;
        const columns = insert ? (names ?? []) : ["row id"];
        out.chunk = chunkHead(r, columns);
        const rows = plural(out.chunk.rows, "row");
        out.summary = insert ? `INSERT ${rows} into ${target}` : `DELETE ${rows} from ${target}`;
        out.fields.push(["Table", target], ["Rows", out.chunk.rows.toLocaleString("en-US")]);
        if (!withData) return out;
        out.chunk = readChunk(r, true, columns);
        break;
      }
      case WalType.UPDATE: {
        r.expect(101, "column_indexes");
        const path = r.list(() => r.uint());
        const column = names?.[path[0] ?? -1] ?? `column ${path[0]}`;
        r.expect(102, "chunk");
        out.chunk = chunkHead(r, [column, "row id"]);
        out.summary = `UPDATE ${plural(out.chunk.rows, "row")} of ${target} (${column})`;
        out.fields.push(
          ["Table", target],
          ["Column", `${column}${path.length > 1 ? ` · path ${path.join(".")}` : ""}`],
          ["Rows", out.chunk.rows.toLocaleString("en-US")],
        );
        if (!withData) return out;
        out.chunk = readChunk(r, true, [column, "row id"]);
        break;
      }
      case WalType.ROW_GROUP_DATA:
        out.summary = `ROW GROUPS for ${target}, already written to the database file`;
        out.fields.push(
          ["Table", target],
          [
            "Holds",
            "Pointers to row groups a large insert already wrote into the database's blocks, with their statistics",
          ],
        );
        return out;
      case WalType.SEQUENCE_VALUE: {
        const seq = dropped();
        r.expect(103, "usage_count");
        const usage = r.uint();
        r.expect(104, "counter");
        const counter = r.svarint();
        out.fields.push(["Sequence", seq], ["Counter", String(counter)], ["Used", String(usage)]);
        out.summary = `SEQUENCE ${seq} counter = ${counter}`;
        break;
      }
      case WalType.CREATE_SCHEMA:
      case WalType.DROP_SCHEMA: {
        r.expect(101, "schema");
        const schema = r.string();
        const verb = out.type === WalType.CREATE_SCHEMA ? "CREATE" : "DROP";
        out.fields.push(["Schema", schema]);
        out.summary = `${verb} SCHEMA ${schema}`;
        out.sql = `${out.summary};`;
        break;
      }
      case WalType.ALTER:
        r.expect(101, "alter info");
        readAlter(r, out);
        break;
      case WalType.CREATE_INDEX:
        r.expect(101, "index");
        readCreateInfo(r, out);
        throw new Unsupported("index storage");
      default:
        if (CREATES.has(out.type)) {
          r.expect(101, "catalog entry");
          readCreateInfo(r, out);
        } else if (DROPS.has(out.type)) {
          const dropTarget = dropped();
          const what = name.replace("DROP_", "").replace("_", " ");
          out.fields.push(["Name", dropTarget]);
          out.summary = `DROP ${what} ${dropTarget}`;
          out.sql = `${out.summary};`;
        } else {
          throw new Unsupported(`entries of type ${out.type}`);
        }
    }
    r.close(`this ${name} entry`);
  } catch (error) {
    if (error instanceof Truncated) out.stopped = `The entry ends before its data does (${error.message}).`;
    else if (error instanceof Unsupported) {
      const at = (r.pos - start).toLocaleString("en-US");
      const size = (end - start).toLocaleString("en-US");
      out.stopped = `Decoded up to byte ${at} of ${size}; the rest holds ${error.message}, which this viewer doesn't decode.`;
    } else if (!(error instanceof QuietStop)) throw error;
  }
  return out;
}
