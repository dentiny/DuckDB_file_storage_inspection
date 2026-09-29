/**
 * Reads DuckDB's write-ahead log: a version header, then entries framed as `size u64, checksum u64, payload`.
 * Payloads use DuckDB's BinarySerializer: little-endian u16 field ids, LEB128 integers, and 0xFFFF closing each
 * object. Field ids and layouts follow DuckDB v1.x's `write_ahead_log.cpp` and `storage/serialization/*.cpp`.
 */

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

const T = {
  VERSION: 98,
  CHECKPOINT: 99,
  FLUSH: 100,
  USE_TABLE: 25,
  INSERT: 26,
  DELETE: 27,
  UPDATE: 28,
  ROW_GROUP_DATA: 29,
} as const;

const TERMINATOR = 0xffff;
const FRAME_HEADER = 16;
/** Rows kept per entry when showing its data. */
export const MAX_ROWS = 200;
const ENCRYPTED_VERSION = 3;

export type Category = "catalog" | "data" | "commit" | "meta";

export interface WalEntry {
  index: number;
  /** File offset of the frame (or of the header, for the version entry). */
  start: number;
  end: number;
  /** Where the serialized payload starts and ends; the end is cut short when the file is. */
  payloadStart: number;
  payloadEnd: number;
  type: number;
  typeName: string;
  category: Category;
  /** Transaction number, counting commits from 1; entries after the last commit share the next number. */
  txn: number;
  /** Why the entry can't be trusted as a whole, e.g. cut off or never committed. Empty when complete. */
  problems: string[];
  summary: string;
  /** `schema.table` that data entries apply to, from the USE_TABLE before them. */
  table: string | null;
}

export interface WalFile {
  name: string;
  size: number;
  /** Bytes read; less than `size` when the log is larger than what was fetched. */
  read: number;
  bytes: Uint8Array;
  version: number | null;
  checkpointIteration: number | null;
  encrypted: boolean;
  entries: WalEntry[];
  commits: number;
  /** A note about the file as a whole, e.g. that it belongs to another checkpoint. */
  notes: string[];
  /** Column names per `schema.table`, from the database and from CREATE TABLE entries in the log. */
  tables: Map<string, string[]>;
}

export interface WalDetail {
  fields: [string, string][];
  sql: string | null;
  chunk: ChunkView | null;
  /** Set when decoding stopped early, saying where and why. */
  stopped: string | null;
}

export interface ChunkView {
  rows: number;
  columns: { name: string; type: string }[];
  /** Up to MAX_ROWS rows, each formatted per column; null is SQL NULL. */
  cells: (string | null)[][];
}

class Truncated extends Error {}
class Unsupported extends Error {}

class Reader {
  pos: number;
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number) {
    if (this.pos + n > this.end) throw new Truncated(`needs ${n} more bytes at offset ${this.pos}`);
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  raw(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  uvarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) return result;
      if (shift > 140n) throw new Unsupported("varint is too long");
    }
  }

  svarint(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (shift > 140n) throw new Unsupported("varint is too long");
    } while (b & 0x80);
    if (b & 0x40) result -= 1n << shift;
    return result;
  }

  uint(): number {
    return Number(this.uvarint());
  }

  int(): number {
    return Number(this.svarint());
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  blob(): Uint8Array {
    return this.raw(this.uint());
  }

  string(): string {
    return new TextDecoder().decode(this.blob());
  }

  peek(): number | null {
    return this.pos + 2 <= this.end ? this.view.getUint16(this.pos, true) : null;
  }

  /** Consumes field `id` if it comes next; optional fields are left out when they hold their default. */
  field(id: number): boolean {
    if (this.peek() !== id) return false;
    this.pos += 2;
    return true;
  }

  expect(id: number, what: string): void {
    const got = this.u16();
    if (got !== id) throw new Unsupported(`expected field ${id} (${what}) but found ${fieldName(got)}`);
  }

  close(what: string): void {
    const got = this.u16();
    if (got !== TERMINATOR) throw new Unsupported(`${what} has ${fieldName(got)} this viewer doesn't know`);
  }

  object<R>(what: string, read: () => R): R {
    const value = read();
    this.close(what);
    return value;
  }

  nullable<R>(read: () => R): R | null {
    return this.bool() ? read() : null;
  }

  list<R>(read: (i: number) => R): R[] {
    const n = this.uint();
    const out: R[] = [];
    for (let i = 0; i < n; i++) out.push(read(i));
    return out;
  }
}

function fieldName(id: number): string {
  return id === TERMINATOR ? "the end of the object" : `field ${id}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Logical types
// ---------------------------------------------------------------------------------------------------------------

export interface LType {
  id: number;
  name: string;
  width?: number;
  scale?: number;
  child?: LType;
  children?: [string, LType][];
  values?: string[];
  size?: number;
}

const TYPE_NAMES: Record<number, string> = {
  1: "NULL",
  10: "BOOLEAN",
  11: "TINYINT",
  12: "SMALLINT",
  13: "INTEGER",
  14: "BIGINT",
  15: "DATE",
  16: "TIME",
  17: "TIMESTAMP_S",
  18: "TIMESTAMP_MS",
  19: "TIMESTAMP",
  20: "TIMESTAMP_NS",
  21: "DECIMAL",
  22: "FLOAT",
  23: "DOUBLE",
  24: "CHAR",
  25: "VARCHAR",
  26: "BLOB",
  27: "INTERVAL",
  28: "UTINYINT",
  29: "USMALLINT",
  30: "UINTEGER",
  31: "UBIGINT",
  32: "TIMESTAMP WITH TIME ZONE",
  34: "TIME WITH TIME ZONE",
  35: "TIME_NS",
  36: "BIT",
  39: "BIGNUM",
  49: "UHUGEINT",
  50: "HUGEINT",
  51: "POINTER",
  54: "UUID",
  60: "GEOMETRY",
  100: "STRUCT",
  101: "LIST",
  102: "MAP",
  104: "ENUM",
  107: "UNION",
  108: "ARRAY",
  109: "VARIANT",
};

const quoteName = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`);

function readType(r: Reader): LType {
  return r.object("a type", () => {
    r.expect(100, "type id");
    const t: LType = { id: r.uint(), name: "" };
    let alias = "";
    if (r.field(101)) {
      r.nullable(() =>
        r.object("type info", () => {
          r.expect(100, "type info kind");
          const kind = r.uint();
          if (r.field(101)) alias = r.string();
          if (r.field(103)) throw new Unsupported("extension type info");
          switch (kind) {
            case 1:
              break;
            case 2:
              t.width = r.field(200) ? r.uint() : 0;
              t.scale = r.field(201) ? r.uint() : 0;
              break;
            case 3:
              if (r.field(200)) r.string();
              break;
            case 4:
              r.expect(200, "list child type");
              t.child = readType(r);
              break;
            case 5:
              t.children = r.field(200)
                ? r.list(() =>
                    r.object("a struct field", () => {
                      r.expect(0, "field name");
                      const name = r.string();
                      r.expect(1, "field type");
                      return [name, readType(r)] as [string, LType];
                    }),
                  )
                : [];
              break;
            case 6:
              r.expect(200, "enum size");
              r.uint();
              r.expect(201, "enum values");
              t.values = r.list(() => r.string());
              break;
            case 7: {
              const name = r.field(200) ? r.string() : "";
              if (r.field(201)) r.string();
              const schema = r.field(202) ? r.string() : "";
              if (r.field(203) || r.field(204)) throw new Unsupported("user type modifiers");
              alias ||= schema ? `${schema}.${name}` : name;
              break;
            }
            case 9:
              r.expect(200, "array child type");
              t.child = readType(r);
              t.size = r.field(201) ? r.uint() : 0;
              break;
            default:
              throw new Unsupported(`type info kind ${kind}`);
          }
        }),
      );
    }
    t.name = alias || typeName(t);
    return t;
  });
}

function typeName(t: LType): string {
  const base = TYPE_NAMES[t.id] ?? `TYPE_${t.id}`;
  switch (t.id) {
    case 21:
      return `DECIMAL(${t.width},${t.scale})`;
    case 101:
      return `${t.child?.name ?? "?"}[]`;
    case 108:
      return `${t.child?.name ?? "?"}[${t.size}]`;
    case 102: {
      const [k, v] = t.child?.children ?? [];
      return `MAP(${k?.[1].name ?? "?"}, ${v?.[1].name ?? "?"})`;
    }
    case 100:
    case 107: {
      const fields = (t.children ?? []).filter(([n], i) => !(t.id === 107 && i === 0 && n === ""));
      return `${base}(${fields.map(([n, c]) => `${quoteName(n)} ${c.name}`).join(", ")})`;
    }
    case 104: {
      const values = t.values ?? [];
      const shown = values.slice(0, 4).map((v) => `'${v.replaceAll("'", "''")}'`);
      return `ENUM(${shown.join(", ")}${values.length > 4 ? ", …" : ""})`;
    }
    default:
      return base;
  }
}

type Physical =
  | "bool"
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "i128"
  | "u128"
  | "f32"
  | "f64"
  | "interval"
  | "varchar"
  | "struct"
  | "list"
  | "array";

function physical(t: LType): Physical {
  switch (t.id) {
    case 10:
      return "bool";
    case 11:
      return "i8";
    case 12:
      return "i16";
    case 13:
    case 15:
      return "i32";
    case 14:
    case 16:
    case 17:
    case 18:
    case 19:
    case 20:
    case 32:
    case 35:
      return "i64";
    case 28:
      return "u8";
    case 29:
      return "u16";
    case 30:
      return "u32";
    case 31:
    case 34:
    case 51:
      return "u64";
    case 50:
    case 54:
      return "i128";
    case 49:
      return "u128";
    case 22:
      return "f32";
    case 23:
      return "f64";
    case 27:
      return "interval";
    case 21: {
      const w = t.width ?? 18;
      return w <= 4 ? "i16" : w <= 9 ? "i32" : w <= 18 ? "i64" : "i128";
    }
    case 104: {
      const n = t.values?.length ?? 0;
      return n <= 0xff ? "u8" : n <= 0xffff ? "u16" : "u32";
    }
    case 24:
    case 25:
    case 26:
    case 36:
    case 39:
    case 60:
      return "varchar";
    case 100:
    case 107:
      return "struct";
    case 101:
    case 102:
      return "list";
    case 108:
      return "array";
    default:
      throw new Unsupported(`values of type ${t.name}`);
  }
}

const WIDTH: Partial<Record<Physical, number>> = {
  bool: 1,
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  f32: 4,
  i64: 8,
  u64: 8,
  f64: 8,
  i128: 16,
  u128: 16,
  interval: 16,
};

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

/** A decoded cell: text for scalars (with whether SQL would quote it), or nested lists and structs. */
type Cell = null | { text: string; quoted: boolean } | Cell[] | { fields: [string, Cell][] } | { map: [Cell, Cell][] };

function isStruct(c: Cell): c is { fields: [string, Cell][] } {
  return c !== null && !Array.isArray(c) && "fields" in c;
}

function show(c: Cell, nested = false): string | null {
  if (c === null) return nested ? "NULL" : null;
  if (Array.isArray(c)) return `[${c.map((x) => show(x, true)).join(", ")}]`;
  if ("map" in c) return `{${c.map.map(([k, v]) => `${show(k, true)}=${show(v, true)}`).join(", ")}}`;
  if (isStruct(c)) return `{${c.fields.map(([k, v]) => `'${k}': ${show(v, true)}`).join(", ")}}`;
  return nested && c.quoted ? `'${c.text.replaceAll("'", "''")}'` : c.text;
}

const pad = (n: number | bigint | string, width = 2) => String(n).padStart(width, "0");

function dateText(days: number): string {
  if (days === 2147483647) return "infinity";
  if (days === -2147483647) return "-infinity";
  const d = new Date(Date.UTC(1970, 0, 1) + days * 86_400_000);
  const y = d.getUTCFullYear();
  const year = y < 0 ? `${pad(-y, 4)} (BC)` : pad(y, 4);
  return `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function timeText(micros: bigint, fractionDigits = 6, per = 1_000_000n): string {
  const whole = micros / per;
  const frac = micros % per;
  const h = whole / 3600n;
  const m = (whole / 60n) % 60n;
  const s = whole % 60n;
  const f = frac ? `.${pad(frac, fractionDigits).replace(/0+$/, "")}` : "";
  return `${pad(h)}:${pad(m)}:${pad(s)}${f}`;
}

function timestampText(value: bigint, per: bigint, digits: number, tz: boolean): string {
  if (value === 9223372036854775807n) return "infinity";
  if (value === -9223372036854775807n) return "-infinity";
  const day = per * 86_400n;
  let days = value / day;
  let rest = value % day;
  if (rest < 0n) {
    rest += day;
    days -= 1n;
  }
  return `${dateText(Number(days))} ${timeText(rest, digits, per)}${tz ? "+00" : ""}`;
}

function decimalText(v: bigint, scale: number): string {
  if (!scale) return v.toString();
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
  return `${neg ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function blobText(b: Uint8Array): string {
  let out = "";
  for (const c of b)
    out += c >= 0x20 && c < 0x7f && c !== 0x5c ? String.fromCharCode(c) : `\\x${pad(c.toString(16).toUpperCase(), 2)}`;
  return out;
}

function intervalText(months: number, days: number, micros: bigint): string {
  const parts: string[] = [];
  const y = Math.trunc(months / 12);
  const mo = months % 12;
  if (y) parts.push(`${y} year${Math.abs(y) === 1 ? "" : "s"}`);
  if (mo) parts.push(`${mo} month${Math.abs(mo) === 1 ? "" : "s"}`);
  if (days) parts.push(`${days} day${Math.abs(days) === 1 ? "" : "s"}`);
  if (micros || !parts.length) parts.push((micros < 0n ? "-" : "") + timeText(micros < 0n ? -micros : micros));
  return parts.join(" ");
}

function scalar(t: LType, view: DataView, at: number): Cell {
  const text = (s: string, quoted = false) => ({ text: s, quoted });
  switch (physical(t)) {
    case "bool":
      return text(view.getUint8(at) ? "true" : "false");
    case "i8":
      return text(String(view.getInt8(at)));
    case "u8":
      return t.id === 104 ? text(t.values?.[view.getUint8(at)] ?? "?", true) : text(String(view.getUint8(at)));
    case "i16":
      return text(
        t.id === 21 ? decimalText(BigInt(view.getInt16(at, true)), t.scale ?? 0) : String(view.getInt16(at, true)),
      );
    case "u16":
      return t.id === 104
        ? text(t.values?.[view.getUint16(at, true)] ?? "?", true)
        : text(String(view.getUint16(at, true)));
    case "i32": {
      const v = view.getInt32(at, true);
      if (t.id === 15) return text(dateText(v), true);
      return text(t.id === 21 ? decimalText(BigInt(v), t.scale ?? 0) : String(v));
    }
    case "u32":
      return t.id === 104
        ? text(t.values?.[view.getUint32(at, true)] ?? "?", true)
        : text(String(view.getUint32(at, true)));
    case "i64": {
      const v = view.getBigInt64(at, true);
      switch (t.id) {
        case 16:
          return text(timeText(v), true);
        case 35:
          return text(timeText(v, 9, 1_000_000_000n), true);
        case 17:
          return text(timestampText(v, 1n, 0, false), true);
        case 18:
          return text(timestampText(v, 1000n, 3, false), true);
        case 19:
          return text(timestampText(v, 1_000_000n, 6, false), true);
        case 20:
          return text(timestampText(v, 1_000_000_000n, 9, false), true);
        case 32:
          return text(timestampText(v, 1_000_000n, 6, true), true);
        case 21:
          return text(decimalText(v, t.scale ?? 0));
        default:
          return text(v.toString());
      }
    }
    case "u64": {
      const v = view.getBigUint64(at, true);
      if (t.id === 34) {
        const offset = 57_599n - (v & 0xffffffn);
        const sign = offset < 0n ? "-" : "+";
        const abs = offset < 0n ? -offset : offset;
        const tz = `${sign}${pad(abs / 3600n)}${abs % 3600n ? `:${pad((abs / 60n) % 60n)}` : ""}`;
        return text(`${timeText(v >> 24n)}${tz}`, true);
      }
      return text(v.toString());
    }
    case "i128":
    case "u128": {
      const lower = view.getBigUint64(at, true);
      const upper = t.id === 49 ? view.getBigUint64(at + 8, true) : view.getBigInt64(at + 8, true);
      if (t.id === 54) {
        const hex =
          (BigInt.asUintN(64, upper) ^ (1n << 63n)).toString(16).padStart(16, "0") +
          lower.toString(16).padStart(16, "0");
        return text(
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
          true,
        );
      }
      const v = (upper << 64n) + lower;
      return text(t.id === 21 ? decimalText(v, t.scale ?? 0) : v.toString());
    }
    case "f32":
      return text(String(+view.getFloat32(at, true).toPrecision(7)));
    case "f64":
      return text(String(view.getFloat64(at, true)));
    case "interval":
      return text(
        intervalText(view.getInt32(at, true), view.getInt32(at + 4, true), view.getBigInt64(at + 8, true)),
        true,
      );
    default:
      throw new Unsupported(`fixed-width values of type ${t.name}`);
  }
}

/** The fields of a serialized Vector, which DuckDB writes as an object inside a DataChunk or a parent vector. */
function readVector(r: Reader, t: LType, count: number): Cell[] {
  const vectorType = r.field(90) ? r.uint() : 0;
  if (vectorType === 2) {
    const [one = null] = readVector(r, t, 1);
    return Array.from({ length: count }, () => one);
  }
  if (vectorType === 4) {
    r.expect(91, "sequence start");
    const start = r.svarint();
    r.expect(92, "sequence increment");
    const step = r.svarint();
    return Array.from({ length: count }, (_, i) => ({ text: (start + step * BigInt(i)).toString(), quoted: false }));
  }
  if (vectorType === 3) {
    r.expect(91, "dictionary selection");
    const sel = r.blob();
    r.expect(92, "dictionary size");
    const dict = readVector(r, t, r.uint());
    const view = new DataView(sel.buffer, sel.byteOffset, sel.byteLength);
    return Array.from({ length: count }, (_, i) => dict[view.getUint32(i * 4, true)] ?? null);
  }
  if (vectorType !== 0) throw new Unsupported(`vector type ${vectorType}`);
  if (r.field(99)) r.uint();

  r.expect(100, "has_validity_mask");
  const mask = r.bool() ? (r.expect(101, "validity"), r.blob()) : null;
  const valid = (i: number) => !mask || ((mask[i >> 3] ?? 0) >> (i & 7)) & 1;
  const kind = physical(t);

  const width = WIDTH[kind];
  if (width) {
    r.expect(102, "data");
    const data = r.blob();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return Array.from({ length: count }, (_, i) => (valid(i) ? scalar(t, view, i * width) : null));
  }
  switch (kind) {
    case "varchar": {
      r.expect(102, "strings");
      const decoder = new TextDecoder();
      const text = t.id === 25 || t.id === 24;
      return r.list((i) => {
        const b = r.blob();
        return valid(i) ? { text: text ? decoder.decode(b) : blobText(b), quoted: true } : null;
      });
    }
    case "struct": {
      const types = t.children ?? [];
      r.expect(103, "struct children");
      const children = r.list((i) => r.object("a struct field vector", () => readVector(r, types[i]?.[1] ?? t, count)));
      return Array.from({ length: count }, (_, row) => {
        if (!valid(row)) return null;
        const fields = types.map(([name], i): [string, Cell] => [name, children[i]?.[row] ?? null]);
        if (t.id === 107) {
          const tag = Number(show(fields[0]?.[1] ?? null) ?? 0);
          const member = fields[tag + 1];
          return member ? { fields: [member] } : null;
        }
        return { fields };
      });
    }
    case "list": {
      r.expect(104, "list size");
      const size = r.uint();
      r.expect(105, "list entries");
      const entries = r.list(() =>
        r.object("a list entry", () => {
          r.expect(100, "offset");
          const offset = r.uint();
          r.expect(101, "length");
          return [offset, r.uint()] as const;
        }),
      );
      r.expect(106, "list child");
      const child = r.object("a list child vector", () => readVector(r, t.child ?? t, size));
      return entries.map(([offset, length], row) => {
        if (!valid(row)) return null;
        const items = child.slice(offset, offset + length);
        if (t.id !== 102) return items;
        return {
          map: items.map((kv): [Cell, Cell] =>
            isStruct(kv) ? [kv.fields[0]?.[1] ?? null, kv.fields[1]?.[1] ?? null] : [kv, null],
          ),
        };
      });
    }
    case "array": {
      r.expect(103, "array size");
      const size = r.uint();
      r.expect(104, "array child");
      const child = r.object("an array child vector", () => readVector(r, t.child ?? t, count * size));
      return Array.from({ length: count }, (_, row) => (valid(row) ? child.slice(row * size, (row + 1) * size) : null));
    }
    default:
      throw new Unsupported(`vectors of type ${t.name}`);
  }
}

/** A DataChunk object. Without `withData` it stops after the row count and types, leaving the reader mid-object. */
function readChunk(r: Reader, withData: boolean, names: string[] = []): ChunkView {
  r.expect(100, "rows");
  const rows = r.uint();
  r.expect(101, "types");
  const types = r.list(() => readType(r));
  const columns = types.map((t, i) => ({ name: names[i] ?? `column ${i + 1}`, type: t.name }));
  if (!withData) return { rows, columns, cells: [] };
  r.expect(102, "columns");
  const vectors = r.list((i) => {
    const type = types[i];
    if (!type) throw new Unsupported("more columns than types");
    return r.object("a column vector", () => readVector(r, type, rows));
  });
  r.close("a data chunk");
  const shown = Math.min(rows, MAX_ROWS);
  const cells = Array.from({ length: shown }, (_, row) => vectors.map((v) => show(v[row] ?? null)));
  return { rows, columns, cells };
}

/** A root Value: its type, a NULL flag, then the value itself. */
function readValue(r: Reader, type?: LType): Cell {
  return r.object("a value", () => {
    const t = type ?? (r.expect(100, "value type"), readType(r));
    if (type && r.field(100)) readType(r);
    r.expect(101, "is_null");
    if (r.bool()) return null;
    return readValueBody(r, t);
  });
}

function readValueBody(r: Reader, t: LType): Cell {
  const kind = physical(t);
  const text = (s: string, quoted = false) => ({ text: s, quoted });
  if (kind === "list" || kind === "struct") {
    r.expect(102, "value children");
    const children = r.object("value children", () => {
      r.expect(100, "children");
      return r.list((i) => {
        const childType = kind === "list" ? t.child : t.children?.[i]?.[1];
        return readValue(r, childType ?? t);
      });
    });
    return kind === "list" ? children : { fields: (t.children ?? []).map(([n], i) => [n, children[i] ?? null]) };
  }
  r.expect(102, "value");
  switch (kind) {
    case "bool":
      return text(r.bool() ? "true" : "false");
    case "i8":
    case "i16":
    case "i32":
    case "i64": {
      const v = r.svarint();
      const bytes = new DataView(new ArrayBuffer(16));
      bytes.setBigInt64(0, v, true);
      if (kind === "i32" && t.id !== 13) return scalar(t, (bytes.setInt32(0, Number(v), true), bytes), 0);
      if (kind === "i64" && t.id !== 14) return scalar(t, bytes, 0);
      return text(t.id === 21 ? decimalText(v, t.scale ?? 0) : v.toString());
    }
    case "u8":
    case "u16":
    case "u32":
    case "u64":
      return text(r.uvarint().toString());
    case "i128":
    case "u128": {
      const upper = kind === "i128" ? r.svarint() : r.uvarint();
      const lower = r.uvarint();
      const v = (upper << 64n) + lower;
      return text(t.id === 21 ? decimalText(v, t.scale ?? 0) : v.toString());
    }
    case "f32": {
      const b = r.raw(4);
      return text(String(+new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true).toPrecision(7)));
    }
    case "f64": {
      const b = r.raw(8);
      return text(String(new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)));
    }
    case "varchar":
      return text(r.string(), true);
    default:
      throw new Unsupported(`constant values of type ${t.name}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsed expressions (column defaults and CHECK constraints)
// ---------------------------------------------------------------------------------------------------------------

const COMPARISON: Record<number, string> = { 25: "=", 26: "<>", 27: "<", 28: ">", 29: "<=", 30: ">=" };

function readExpression(r: Reader): string {
  return r.object("an expression", () => {
    r.expect(100, "expression class");
    const cls = r.uint();
    r.expect(101, "expression type");
    const type = r.uint();
    if (r.field(102)) r.string();
    if (r.field(103)) r.uvarint();
    const nullableExpr = () => r.nullable(() => readExpression(r)) ?? "NULL";
    switch (cls) {
      case 7: {
        r.expect(200, "constant");
        const v = readValue(r);
        return show(v, true) ?? "NULL";
      }
      case 4: {
        const names = r.field(200) ? r.list(() => r.string()) : [];
        return names.map(quoteName).join(".");
      }
      case 3: {
        const child = r.field(200) ? nullableExpr() : "NULL";
        r.expect(201, "cast type");
        const to = readType(r);
        const tryCast = r.field(202) ? r.bool() : false;
        return `${tryCast ? "TRY_CAST" : "CAST"}(${child} AS ${to.name})`;
      }
      case 9: {
        const name = r.field(200) ? r.string() : "";
        const schema = r.field(201) ? r.string() : "";
        const args = r.field(202) ? r.list(() => nullableExpr()) : [];
        if (r.field(203) || r.field(204)) throw new Unsupported("function filters and ORDER BY");
        const distinct = r.field(205) ? r.bool() : false;
        const operator = r.field(206) ? r.bool() : false;
        if (r.field(207)) r.bool();
        if (r.field(208)) r.string();
        if (operator && args.length === 2) return `(${args[0]} ${name} ${args[1]})`;
        return `${schema ? `${schema}.` : ""}${name}(${distinct ? "DISTINCT " : ""}${args.join(", ")})`;
      }
      case 5: {
        const left = r.field(200) ? nullableExpr() : "NULL";
        const right = r.field(201) ? nullableExpr() : "NULL";
        return `(${left} ${COMPARISON[type] ?? "?"} ${right})`;
      }
      case 6: {
        const children = r.field(200) ? r.list(() => nullableExpr()) : [];
        return `(${children.join(type === 28 ? " OR " : " AND ")})`;
      }
      default:
        throw new Unsupported(`expressions of class ${cls}`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog entries
// ---------------------------------------------------------------------------------------------------------------

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

interface Out {
  fields: [string, string][];
  sql: string | null;
  summary: string;
  chunk: ChunkView | null;
  table?: string;
  columns?: string[];
}

const qualified = (schema: string, name: string) => (schema ? `${schema}.${name}` : name);

/** CreateInfo and its subclass, as written for CREATE TABLE/VIEW/SEQUENCE/MACRO/TYPE/INDEX entries. */
function readCreateInfo(r: Reader, out: Out, walType: string): void {
  r.nullable(() =>
    r.object("create info", () => {
      r.expect(100, "catalog type");
      const kind = r.uint();
      const catalog = r.field(101) ? r.string() : "";
      const schema = r.field(102) ? r.string() : "";
      const temporary = r.field(103) ? r.bool() : false;
      if (r.field(104)) r.bool();
      r.expect(105, "on_conflict");
      const conflict = r.uint();
      const sql = r.field(106) ? r.string() : "";
      out.fields.push(["Kind", CATALOG_TYPES[kind] ?? `catalog type ${kind}`]);
      if (catalog) out.fields.push(["Catalog", catalog]);
      out.fields.push(["Schema", schema || "main"]);
      if (temporary) out.fields.push(["Temporary", "yes"]);
      if (conflict)
        out.fields.push(["On conflict", ["error", "ignore", "replace", "alter"][conflict] ?? String(conflict)]);
      if (sql) out.sql = sql;
      out.summary = `${walType.replace("_", " ")} ${schema || "main"}`;
      if (r.field(107)) out.fields.push(["Comment", show(readValue(r)) ?? "NULL"]);
      if (r.field(108)) {
        const tags = r.list(() =>
          r.object("a tag", () => (r.expect(0, "key"), [r.string(), (r.expect(1, "value"), r.string())])),
        );
        out.fields.push(["Tags", tags.map(([k, v]) => `${k}=${v}`).join(", ")]);
      }
      if (r.field(109)) throw new Unsupported("catalog dependencies");

      const create = (what: string, name: string) => {
        out.fields.push(["Name", name]);
        out.summary = `CREATE ${what} ${qualified(schema || "main", name)}`;
      };
      switch (kind) {
        case 1: {
          const table = r.field(200) ? r.string() : "";
          create("TABLE", table);
          r.expect(201, "columns");
          const columns = r.object("a column list", () =>
            r.field(100)
              ? r.list(() =>
                  r.object("a column", () => {
                    const name = r.field(100) ? r.string() : "";
                    r.expect(101, "column type");
                    const type = readType(r);
                    const def = r.field(102) ? r.nullable(() => readExpression(r)) : null;
                    r.expect(103, "column category");
                    const generated = r.uint() === 1;
                    r.expect(104, "compression");
                    r.uint();
                    if (r.field(105)) readValue(r);
                    if (r.field(106))
                      r.list(() =>
                        r.object("a tag", () => (r.expect(0, "key"), r.string(), r.expect(1, "value"), r.string())),
                      );
                    return { name, type: type.name, def, generated };
                  }),
                )
              : [],
          );
          out.table = qualified(schema || "main", table);
          out.columns = columns.map((c) => c.name);
          out.summary = `CREATE TABLE ${out.table} (${columns.length} column${columns.length === 1 ? "" : "s"})`;
          const lines = columns.map(
            (c) =>
              `  ${quoteName(c.name)} ${c.type}${c.def ? (c.generated ? ` GENERATED ALWAYS AS (${c.def})` : ` DEFAULT ${c.def}`) : ""}`,
          );
          out.sql = `CREATE TABLE ${out.table} (\n${lines.join(",\n")}\n);`;
          if (r.field(202)) {
            const constraints = r.list(() =>
              r.nullable(() =>
                readConstraint(
                  r,
                  columns.map((c) => c.name),
                ),
              ),
            );
            const notNull = new Set(constraints.filter((c): c is number => typeof c === "number"));
            const text = constraints.filter((c): c is string => typeof c === "string");
            const withNotNull = lines.map((l, i) => (notNull.has(i) ? `${l} NOT NULL` : l));
            out.sql = `CREATE TABLE ${out.table} (\n${[...withNotNull, ...text.map((c) => `  ${c}`)].join(",\n")}\n);`;
          }
          if (r.field(203)) throw new Unsupported("CREATE TABLE AS queries");
          return;
        }
        case 2:
          out.summary = `CREATE SCHEMA ${schema}`;
          out.sql ??= `CREATE SCHEMA ${schema};`;
          return;
        case 3: {
          const view = r.field(200) ? r.string() : "";
          create("VIEW", view);
          return stopQuietly(r);
        }
        case 6: {
          const name = r.field(200) ? r.string() : "";
          create("SEQUENCE", name);
          const usage = r.field(201) ? r.uint() : 0;
          const increment = r.field(202) ? r.svarint() : 0n;
          const min = r.field(203) ? r.svarint() : 0n;
          const max = r.field(204) ? r.svarint() : 0n;
          const start = r.field(205) ? r.svarint() : 0n;
          const cycle = r.field(206) ? r.bool() : false;
          out.fields.push(
            ["Start", String(start)],
            ["Increment", String(increment)],
            ["Min", String(min)],
            ["Max", String(max)],
          );
          if (usage) out.fields.push(["Used", String(usage)]);
          out.sql ??= `CREATE SEQUENCE ${qualified(schema || "main", name)} START ${start} INCREMENT ${increment}${cycle ? " CYCLE" : ""};`;
          return;
        }
        case 8: {
          const name = r.field(200) ? r.string() : "";
          create("TYPE", name);
          r.expect(201, "type");
          const t = readType(r);
          out.fields.push(["Type", t.name]);
          out.sql ??= `CREATE TYPE ${qualified(schema || "main", name)} AS ${t.name};`;
          return;
        }
        case 30:
        case 31: {
          const name = r.field(200) ? r.string() : "";
          create(kind === 31 ? "MACRO (table)" : "MACRO", name);
          return stopQuietly(r);
        }
        case 4: {
          const name = r.field(200) ? r.string() : "";
          const table = r.field(201) ? r.string() : "";
          out.fields.push(["Name", name], ["Table", table]);
          out.summary = `CREATE INDEX ${name} ON ${qualified(schema || "main", table)}`;
          return stopQuietly(r);
        }
        default:
          throw new Unsupported(`CREATE for catalog type ${kind}`);
      }
    }),
  );
}

/** Ends decoding without a warning where the rest (a view's query, a macro's body) is already in `sql`. */
class QuietStop extends Error {}
function stopQuietly(_r: Reader): never {
  throw new QuietStop();
}

/** A table constraint as SQL, or the column index of a NOT NULL constraint, which belongs on the column. */
function readConstraint(r: Reader, columns: string[]): string | number {
  return r.object("a constraint", () => {
    r.expect(100, "constraint type");
    const type = r.uint();
    const index = () => r.uint();
    switch (type) {
      case 1:
        r.expect(200, "not null column");
        return index();
      case 2:
        return `CHECK ${r.field(200) ? (r.nullable(() => readExpression(r)) ?? "") : ""}`;
      case 3: {
        const pk = r.field(200) ? r.bool() : false;
        r.expect(201, "unique column index");
        const i = index();
        const names = r.field(202) ? r.list(() => r.string()) : [];
        const cols = names.length ? names : i < columns.length ? [columns[i] ?? ""] : [];
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

function readAlter(r: Reader, out: Out): void {
  r.nullable(() =>
    r.object("alter info", () => {
      r.expect(100, "parse info type");
      r.uint();
      r.expect(200, "alter type");
      const kind = r.uint();
      if (r.field(201)) r.string();
      const schema = r.field(202) ? r.string() : "main";
      const name = r.field(203) ? r.string() : "";
      r.expect(204, "if_not_found");
      r.uint();
      if (r.field(205)) r.bool();
      const target = qualified(schema, name);
      out.fields.push(["Alters", ALTER_TYPES[kind] ?? `alter type ${kind}`], ["Target", target]);
      out.summary = `ALTER ${ALTER_TYPES[kind] ?? ""} ${target}`;
      if (kind !== 1) return stopQuietly(r);
      r.expect(300, "alter table type");
      const sub = r.uint();
      const action = ALTER_TABLE[sub] ?? `change ${sub}`;
      out.summary = `ALTER TABLE ${target} ${action}`;
      out.fields.push(["Change", action]);
      if (sub === 1) {
        const from = r.field(400) ? r.string() : "";
        const to = r.field(401) ? r.string() : "";
        out.summary = `ALTER TABLE ${target} RENAME ${from} TO ${to}`;
        out.sql = `ALTER TABLE ${target} RENAME COLUMN ${quoteName(from)} TO ${quoteName(to)};`;
      } else if (sub === 2) {
        const to = r.field(400) ? r.string() : "";
        out.summary = `ALTER TABLE ${target} RENAME TO ${to}`;
        out.sql = `ALTER TABLE ${target} RENAME TO ${quoteName(to)};`;
      } else if (sub === 4) {
        const column = r.field(400) ? r.string() : "";
        out.summary = `ALTER TABLE ${target} DROP COLUMN ${column}`;
        out.sql = `ALTER TABLE ${target} DROP COLUMN ${quoteName(column)};`;
      } else if (sub === 3) {
        r.expect(400, "new column");
        const n = r.field(100) ? r.string() : "";
        r.expect(101, "column type");
        const column = `${quoteName(n)} ${readType(r).name}`;
        out.summary = `ALTER TABLE ${target} ADD COLUMN ${column}`;
        out.sql = `ALTER TABLE ${target} ADD COLUMN ${column};`;
      }
      return stopQuietly(r);
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------

function category(type: number): Category {
  if (type === T.FLUSH) return "commit";
  if (type === T.INSERT || type === T.DELETE || type === T.UPDATE || type === T.ROW_GROUP_DATA) return "data";
  if (type === T.USE_TABLE || type === T.VERSION || type === T.CHECKPOINT || type === 10) return "meta";
  return "catalog";
}

const plural = (n: number, what: string) => `${n.toLocaleString("en-US")} ${what}${n === 1 ? "" : "s"}`;

/**
 * Decodes one entry's payload. With `withData`, data entries also decode every row; without, only their row
 * count and types, which is enough for the entry list.
 */
function decodePayload(
  bytes: Uint8Array,
  start: number,
  end: number,
  context: { table: string | null; tables: Map<string, string[]> },
  withData: boolean,
): Out & { type: number; stopped: string | null } {
  const r = new Reader(bytes, start, end);
  const out: Out = { fields: [], sql: null, summary: "", chunk: null };
  let type = -1;
  let stopped: string | null = null;
  try {
    r.expect(100, "wal_type");
    type = r.uint();
    const name = WAL_TYPES[type] ?? `type ${type}`;
    out.summary = name;
    const names = context.table ? context.tables.get(context.table) : undefined;
    switch (type) {
      case T.VERSION: {
        r.expect(101, "version");
        const version = r.uint();
        out.fields.push(["Version", String(version)]);
        out.summary = `WAL version ${version}${version === ENCRYPTED_VERSION ? " (encrypted)" : ""}`;
        if (r.field(102)) {
          const id = r.list(() => r.uint());
          out.fields.push(["Database id", id.map((b) => pad(b.toString(16))).join("")]);
        }
        if (r.field(103)) {
          const iteration = r.uint();
          out.fields.push(["Checkpoint", String(iteration)]);
        }
        break;
      }
      case T.CHECKPOINT: {
        r.expect(101, "meta_block");
        const pointer = r.object("a block pointer", () => ({
          block: r.field(100) ? r.uvarint() : 0n,
          offset: r.field(101) ? r.uint() : 0,
        }));
        const block = Number(pointer.block & 0x00ff_ffff_ffff_ffffn);
        const index = Number(pointer.block >> 56n);
        out.fields.push(["Metadata", `block ${block} · sub-block ${index} · offset ${pointer.offset}`]);
        out.summary = `CHECKPOINT to metadata block ${block}`;
        break;
      }
      case T.FLUSH:
        out.summary = "COMMIT";
        break;
      case T.USE_TABLE: {
        r.expect(101, "schema");
        const schema = r.string();
        r.expect(102, "table");
        const table = r.string();
        out.table = qualified(schema, table);
        out.fields.push(["Table", out.table]);
        out.summary = `USE TABLE ${out.table}`;
        break;
      }
      case T.INSERT:
      case T.DELETE: {
        r.expect(101, "chunk");
        const columnNames = type === T.INSERT ? names : ["row id"];
        // Row count and types come first, so they survive even when the rows themselves are cut off.
        const head = readChunk(new Reader(bytes, r.pos, end), false, columnNames);
        const target = context.table ?? "the current table";
        out.chunk = head;
        out.summary =
          type === T.INSERT
            ? `INSERT ${plural(head.rows, "row")} into ${target}`
            : `DELETE ${plural(head.rows, "row")} from ${target}`;
        out.fields.push(["Table", target], ["Rows", head.rows.toLocaleString("en-US")]);
        if (!withData) return { ...out, type, stopped: null };
        out.chunk = readChunk(r, true, columnNames);
        break;
      }
      case T.UPDATE: {
        r.expect(101, "column_indexes");
        const path = r.list(() => r.uint());
        const column = names?.[path[0] ?? -1] ?? `column ${path[0]}`;
        const target = context.table ?? "the current table";
        r.expect(102, "chunk");
        const head = readChunk(new Reader(bytes, r.pos, end), false, [column, "row id"]);
        out.chunk = head;
        out.summary = `UPDATE ${plural(head.rows, "row")} of ${target} (${column})`;
        out.fields.push(
          ["Table", target],
          ["Column", `${column}${path.length > 1 ? ` · path ${path.join(".")}` : ""}`],
        );
        out.fields.push(["Rows", head.rows.toLocaleString("en-US")]);
        if (!withData) return { ...out, type, stopped: null };
        out.chunk = readChunk(r, true, [column, "row id"]);
        break;
      }
      case T.ROW_GROUP_DATA: {
        out.summary = `ROW GROUPS for ${context.table ?? "the current table"}, already written to the database file`;
        out.fields.push(
          ["Table", context.table ?? "the current table"],
          [
            "Holds",
            "Pointers to row groups a large insert already wrote into the database's blocks, with their statistics",
          ],
        );
        return { ...out, type, stopped: null };
      }
      case 10: {
        r.expect(101, "schema");
        const schema = r.string();
        r.expect(102, "name");
        const seq = qualified(schema, r.string());
        r.expect(103, "usage_count");
        const usage = r.uint();
        r.expect(104, "counter");
        const counter = r.svarint();
        out.fields.push(["Sequence", seq], ["Counter", String(counter)], ["Used", String(usage)]);
        out.summary = `SEQUENCE ${seq} counter = ${counter}`;
        break;
      }
      case 2:
      case 6:
      case 9:
      case 12:
      case 14:
      case 22:
      case 24: {
        r.expect(101, "schema");
        const schema = r.string();
        r.expect(102, "name");
        const target = qualified(schema, r.string());
        const what = name.replace("DROP_", "").replace("_", " ");
        out.fields.push(["Name", target]);
        out.summary = `DROP ${what} ${target}`;
        out.sql = `DROP ${what} ${target};`;
        break;
      }
      case 4: {
        r.expect(101, "schema");
        const schema = r.string();
        out.summary = `DROP SCHEMA ${schema}`;
        out.sql = `DROP SCHEMA ${schema};`;
        break;
      }
      case 3: {
        r.expect(101, "schema");
        const schema = r.string();
        out.fields.push(["Schema", schema]);
        out.summary = `CREATE SCHEMA ${schema}`;
        out.sql = `CREATE SCHEMA ${schema};`;
        break;
      }
      case 1:
      case 5:
      case 8:
      case 11:
      case 13:
      case 21:
        r.expect(101, "catalog entry");
        readCreateInfo(r, out, name);
        break;
      case 23:
        r.expect(101, "index");
        readCreateInfo(r, out, name);
        throw new Unsupported("index storage");
      case 20:
        r.expect(101, "alter info");
        readAlter(r, out);
        break;
      default:
        throw new Unsupported(`entries of type ${type}`);
    }
    r.close(`this ${name} entry`);
  } catch (error) {
    if (error instanceof QuietStop) stopped = null;
    else if (error instanceof Truncated) stopped = `The entry ends before its data does (${error.message}).`;
    else if (error instanceof Unsupported)
      stopped = `Decoded up to byte ${(r.pos - start).toLocaleString("en-US")} of ${(end - start).toLocaleString("en-US")}; the rest holds ${error.message}, which this viewer doesn't decode.`;
    else throw error;
  }
  return { ...out, type, stopped };
}

// ---------------------------------------------------------------------------------------------------------------
// Framing and checksums
// ---------------------------------------------------------------------------------------------------------------

const M64 = (1n << 64n) - 1n;
const mul = (a: bigint, b: bigint) => (a * b) & M64;

function checksumRemainder(b: Uint8Array): bigint {
  const M = 0xc6a4a7935bd1e995n;
  const R = 47n;
  let h = 0xe17a1465n ^ mul(BigInt(b.length), M);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const blocks = Math.floor(b.length / 8);
  for (let i = 0; i < blocks; i++) {
    let k = view.getBigUint64(i * 8, true);
    k = mul(k, M);
    k ^= k >> R;
    k = mul(k, M);
    h ^= k;
    h = mul(h, M);
  }
  const tail = b.length & 7;
  if (tail) {
    for (let i = tail - 1; i >= 0; i--) h ^= BigInt(b[blocks * 8 + i] ?? 0) << BigInt(i * 8);
    h = mul(h, M);
  }
  h ^= h >> R;
  h = mul(h, M);
  h ^= h >> R;
  return h;
}

/** DuckDB's entry checksum: 64-bit words multiplied by a constant and XORed, the leftover bytes hashed. */
export function walChecksum(b: Uint8Array): bigint {
  let result = 5381n;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const words = Math.floor(b.length / 8);
  for (let i = 0; i < words; i++) result ^= mul(view.getBigUint64(i * 8, true), 0xbf58476d1ce4e5b9n);
  if (b.length % 8) result ^= checksumRemainder(b.subarray(words * 8));
  return result;
}

export interface WalOptions {
  name: string;
  /** Full size of the log; more than `bytes.length` when only its start was read. */
  size?: number;
  /** Column names per `schema.table`, e.g. from the database's catalog. */
  tables?: Map<string, string[]>;
  /** The database's checkpoint iteration, to tell whether the log belongs to it. */
  checkpointIteration?: number;
}

/** Splits a WAL into entries and works out which are complete. Data entries are only counted here. */
export function parseWal(bytes: Uint8Array, options: WalOptions): WalFile {
  const size = options.size ?? bytes.length;
  const tables = new Map(options.tables);
  const file: WalFile = {
    name: options.name,
    size,
    read: bytes.length,
    bytes,
    version: null,
    checkpointIteration: null,
    encrypted: false,
    entries: [],
    commits: 0,
    notes: [],
    tables,
  };
  if (!bytes.length) return file;

  const context = { table: null as string | null, tables };
  const push = (entry: Omit<WalEntry, "index" | "txn" | "category" | "typeName">) => {
    file.entries.push({
      ...entry,
      index: file.entries.length,
      txn: 0,
      category: category(entry.type),
      typeName: WAL_TYPES[entry.type] ?? (entry.type < 0 ? "UNREADABLE" : `TYPE_${entry.type}`),
    });
  };

  // The version entry is written without a frame, so its end is where its object closes.
  const header = new Reader(bytes, 0, bytes.length);
  let pos: number;
  try {
    header.expect(100, "wal_type");
    if (header.uint() !== T.VERSION) throw new Unsupported("no version entry");
    header.expect(101, "version");
    file.version = header.uint();
    if (header.field(102)) header.list(() => header.uint());
    if (header.field(103)) file.checkpointIteration = header.uint();
    header.close("the version entry");
    pos = header.pos;
    const decoded = decodePayload(bytes, 0, pos, context, false);
    push({
      start: 0,
      end: pos,
      payloadStart: 0,
      payloadEnd: pos,
      type: T.VERSION,
      problems: [],
      summary: decoded.summary,
      table: null,
    });
  } catch (error) {
    if (!(error instanceof Truncated || error instanceof Unsupported)) throw error;
    file.notes.push(`This doesn't start like a DuckDB WAL (${error.message}).`);
    push({
      start: 0,
      end: bytes.length,
      payloadStart: 0,
      payloadEnd: bytes.length,
      type: -1,
      problems: ["unreadable: no WAL version header"],
      summary: "Unreadable bytes",
      table: null,
    });
    return file;
  }

  if (file.version === ENCRYPTED_VERSION) {
    file.encrypted = true;
    file.notes.push("The log is encrypted, so its entries can't be read without the database key.");
    return file;
  }
  if (
    file.checkpointIteration !== null &&
    options.checkpointIteration !== undefined &&
    file.checkpointIteration !== options.checkpointIteration
  ) {
    file.notes.push(
      `The log was written after checkpoint ${file.checkpointIteration}, but the database is at checkpoint ${options.checkpointIteration}; DuckDB won't replay it.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readEnd = bytes.length;
  while (pos < readEnd) {
    const start = pos;
    if (readEnd - pos < FRAME_HEADER) {
      if (bytes.length < size) break;
      push({
        start,
        end: readEnd,
        payloadStart: readEnd,
        payloadEnd: readEnd,
        type: -1,
        problems: [`truncated: ${readEnd - pos} bytes, fewer than an entry's 16-byte size and checksum`],
        summary: "Torn entry header",
        table: null,
      });
      break;
    }
    const length = Number(view.getBigUint64(pos, true));
    const expected = view.getBigUint64(pos + 8, true);
    const payloadStart = pos + FRAME_HEADER;
    const fullEnd = payloadStart + length;
    const payloadEnd = Math.min(fullEnd, readEnd);
    if (fullEnd > readEnd && bytes.length < size) break;
    const problems: string[] = [];
    const cut = fullEnd > readEnd;
    if (cut) {
      problems.push(
        `truncated: the entry is ${length.toLocaleString("en-US")} bytes but only ${(readEnd - payloadStart).toLocaleString("en-US")} are in the file`,
      );
    } else if (walChecksum(bytes.subarray(payloadStart, fullEnd)) !== expected) {
      problems.push("checksum mismatch: the entry was only partly written or has been corrupted");
    }
    const decoded = decodePayload(bytes, payloadStart, payloadEnd, context, false);
    if (decoded.table && decoded.type === T.USE_TABLE) context.table = decoded.table;
    if (decoded.table && decoded.columns && !problems.length) tables.set(decoded.table, decoded.columns);
    const dataTable = category(decoded.type) === "data" ? context.table : (decoded.table ?? null);
    push({
      start,
      end: payloadEnd,
      payloadStart,
      payloadEnd,
      type: decoded.type,
      problems,
      summary: decoded.summary || "Unreadable entry",
      table: dataTable,
    });
    pos = payloadEnd;
    // DuckDB stops replaying at the first entry it can't trust; so do we.
    if (problems.length) {
      if (pos < readEnd) {
        push({
          start: pos,
          end: readEnd,
          payloadStart: pos,
          payloadEnd: readEnd,
          type: -1,
          problems: ["after a damaged entry, so DuckDB never reads it"],
          summary: `${(readEnd - pos).toLocaleString("en-US")} bytes after the damaged entry`,
          table: null,
        });
      }
      break;
    }
  }
  if (bytes.length < size) {
    file.notes.push(
      `Only the first ${bytes.length.toLocaleString("en-US")} of ${size.toLocaleString("en-US")} bytes were read; later entries aren't listed.`,
    );
  }

  let txn = 1;
  for (const entry of file.entries) {
    entry.txn = txn;
    if (entry.type === T.FLUSH && !entry.problems.length) {
      file.commits += 1;
      txn += 1;
    }
  }
  let lastCommit = -1;
  file.entries.forEach((e, i) => {
    if (e.type === T.FLUSH && !e.problems.length) lastCommit = i;
  });
  // A commit may still follow in the part of the log that wasn't read.
  const tail = bytes.length < size ? [] : file.entries.slice(lastCommit + 1);
  for (const entry of tail) {
    if (entry.type === T.VERSION) continue;
    entry.problems.push("not committed: no COMMIT follows it, so DuckDB discards it on replay");
  }
  return file;
}

/** Everything an entry holds, including up to MAX_ROWS rows for data entries. */
export function decodeEntry(file: WalFile, entry: WalEntry): WalDetail {
  if (entry.type < 0) return { fields: [], sql: null, chunk: null, stopped: null };
  const decoded = decodePayload(
    file.bytes,
    entry.payloadStart,
    entry.payloadEnd,
    { table: entry.table, tables: file.tables },
    true,
  );
  return { fields: decoded.fields, sql: decoded.sql, chunk: decoded.chunk, stopped: decoded.stopped };
}

export function isIncomplete(entry: WalEntry): boolean {
  return entry.problems.length > 0;
}
