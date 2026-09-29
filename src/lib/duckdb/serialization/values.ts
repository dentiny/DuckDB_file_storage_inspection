import { Unsupported, type Reader } from "./reader";
import { physical, readType, TypeId, WIDTH, type LType, type Physical } from "./types";

/** Rows kept per chunk when showing its data. */
export const MAX_ROWS = 200;

/** A decoded value: text for scalars (with whether SQL would quote it), or nested lists, structs and maps. */
export type Cell =
  null | { text: string; quoted: boolean } | Cell[] | { fields: [string, Cell][] } | { map: [Cell, Cell][] };

export interface ChunkView {
  rows: number;
  columns: { name: string; type: string }[];
  /** Up to MAX_ROWS rows, each formatted per column; null is SQL NULL. */
  cells: (string | null)[][];
}

const isStruct = (c: Cell): c is { fields: [string, Cell][] } => c !== null && !Array.isArray(c) && "fields" in c;

/** A cell as DuckDB prints it; nested values quote their strings, and a top-level NULL is null. */
export function show(c: Cell, nested = false): string | null {
  if (c === null) return nested ? "NULL" : null;
  if (Array.isArray(c)) return `[${c.map((x) => show(x, true)).join(", ")}]`;
  if ("map" in c) return `{${c.map.map(([k, v]) => `${show(k, true)}=${show(v, true)}`).join(", ")}}`;
  if (isStruct(c)) return `{${c.fields.map(([k, v]) => `'${k}': ${show(v, true)}`).join(", ")}}`;
  return nested && c.quoted ? `'${c.text.replaceAll("'", "''")}'` : c.text;
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------

const pad = (n: number | bigint | string, width = 2) => String(n).padStart(width, "0");
const INFINITE_DATE = 2147483647;
const INFINITE_TIMESTAMP = 9223372036854775807n;
/** TIME WITH TIME ZONE stores its offset as this minus the offset in seconds, below the time's micros. */
const MAX_TZ_OFFSET = 57_599n;

function dateText(days: number): string {
  if (days === INFINITE_DATE) return "infinity";
  if (days === -INFINITE_DATE) return "-infinity";
  const d = new Date(Date.UTC(1970, 0, 1) + days * 86_400_000);
  const y = d.getUTCFullYear();
  const year = y < 0 ? `${pad(-y, 4)} (BC)` : pad(y, 4);
  return `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Time of day from `ticks` at `perSecond` ticks a second, with trailing zeros of the fraction dropped. */
function timeText(ticks: bigint, digits = 6, perSecond = 1_000_000n): string {
  const whole = ticks / perSecond;
  const frac = ticks % perSecond;
  const f = frac ? `.${pad(frac, digits).replace(/0+$/, "")}` : "";
  return `${pad(whole / 3600n)}:${pad((whole / 60n) % 60n)}:${pad(whole % 60n)}${f}`;
}

function timestampText(value: bigint, perSecond: bigint, digits: number, tz: boolean): string {
  if (value === INFINITE_TIMESTAMP) return "infinity";
  if (value === -INFINITE_TIMESTAMP) return "-infinity";
  const day = perSecond * 86_400n;
  const rest = ((value % day) + day) % day;
  const days = (value - rest) / day;
  return `${dateText(Number(days))} ${timeText(rest, digits, perSecond)}${tz ? "+00" : ""}`;
}

function timeTzText(bits: bigint): string {
  const offset = MAX_TZ_OFFSET - (bits & 0xffffffn);
  const abs = offset < 0n ? -offset : offset;
  const minutes = abs % 3600n ? `:${pad((abs / 60n) % 60n)}` : "";
  return `${timeText(bits >> 24n)}${offset < 0n ? "-" : "+"}${pad(abs / 3600n)}${minutes}`;
}

function decimalText(v: bigint, scale: number): string {
  if (!scale) return v.toString();
  const digits = (v < 0n ? -v : v).toString().padStart(scale + 1, "0");
  return `${v < 0n ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function uuidText(v: bigint): string {
  // DuckDB flips the top bit so UUIDs sort as signed 128-bit integers.
  const hex = (BigInt.asUintN(128, v) ^ (1n << 127n)).toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function blobText(b: Uint8Array): string {
  let out = "";
  for (const c of b) {
    out += c >= 0x20 && c < 0x7f && c !== 0x5c ? String.fromCharCode(c) : `\\x${pad(c.toString(16).toUpperCase())}`;
  }
  return out;
}

interface Interval {
  months: number;
  days: number;
  micros: bigint;
}

function intervalText({ months, days, micros }: Interval): string {
  const unit = (n: number, what: string) => `${n} ${what}${Math.abs(n) === 1 ? "" : "s"}`;
  const parts: string[] = [];
  const years = Math.trunc(months / 12);
  if (years) parts.push(unit(years, "year"));
  if (months % 12) parts.push(unit(months % 12, "month"));
  if (days) parts.push(unit(days, "day"));
  if (micros || !parts.length) parts.push((micros < 0n ? "-" : "") + timeText(micros < 0n ? -micros : micros));
  return parts.join(" ");
}

/** A scalar as read, before formatting by its logical type. */
type Raw = boolean | number | bigint | Interval;

/** Formats a scalar by its logical type: dates, times, decimals, enums, UUIDs; plain numbers otherwise. */
function format(t: LType, v: Raw): Cell {
  const quoted = (text: string) => ({ text, quoted: true });
  const plain = (text: string) => ({ text, quoted: false });
  if (typeof v === "boolean") return plain(v ? "true" : "false");
  if (typeof v === "object") return quoted(intervalText(v));
  const big = () => BigInt(v);
  switch (t.id) {
    case TypeId.ENUM:
      return quoted(t.values?.[Number(v)] ?? "?");
    case TypeId.DATE:
      return quoted(dateText(Number(v)));
    case TypeId.TIME:
      return quoted(timeText(big()));
    case TypeId.TIME_NS:
      return quoted(timeText(big(), 9, 1_000_000_000n));
    case TypeId.TIME_TZ:
      return quoted(timeTzText(big()));
    case TypeId.TIMESTAMP_S:
      return quoted(timestampText(big(), 1n, 0, false));
    case TypeId.TIMESTAMP_MS:
      return quoted(timestampText(big(), 1000n, 3, false));
    case TypeId.TIMESTAMP:
      return quoted(timestampText(big(), 1_000_000n, 6, false));
    case TypeId.TIMESTAMP_NS:
      return quoted(timestampText(big(), 1_000_000_000n, 9, false));
    case TypeId.TIMESTAMP_TZ:
      return quoted(timestampText(big(), 1_000_000n, 6, true));
    case TypeId.DECIMAL:
      return plain(decimalText(big(), t.scale ?? 0));
    case TypeId.UUID:
      return quoted(uuidText(big()));
    default:
      // FLOAT is kept to its 7 significant digits, so 1.1 doesn't print as 1.100000023841858.
      return plain(String(physical(t) === "f32" ? +Number(v).toPrecision(7) : v));
  }
}

/** A fixed-width value at `at` in a vector's data. */
function readFixed(kind: Physical, view: DataView, at: number): Raw {
  switch (kind) {
    case "bool":
      return view.getUint8(at) !== 0;
    case "i8":
      return view.getInt8(at);
    case "u8":
      return view.getUint8(at);
    case "i16":
      return view.getInt16(at, true);
    case "u16":
      return view.getUint16(at, true);
    case "i32":
      return view.getInt32(at, true);
    case "u32":
      return view.getUint32(at, true);
    case "i64":
      return view.getBigInt64(at, true);
    case "u64":
      return view.getBigUint64(at, true);
    case "i128":
      return (view.getBigInt64(at + 8, true) << 64n) + view.getBigUint64(at, true);
    case "u128":
      return (view.getBigUint64(at + 8, true) << 64n) + view.getBigUint64(at, true);
    case "f32":
      return view.getFloat32(at, true);
    case "f64":
      return view.getFloat64(at, true);
    case "interval":
      return {
        months: view.getInt32(at, true),
        days: view.getInt32(at + 4, true),
        micros: view.getBigInt64(at + 8, true),
      };
    default:
      throw new Unsupported(`fixed-width values of kind ${kind}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Vectors and chunks
// ---------------------------------------------------------------------------------------------------------------

const VectorType = { FLAT: 0, CONSTANT: 2, DICTIONARY: 3, SEQUENCE: 4 } as const;

/** The fields of a serialized Vector, which DuckDB writes as an object inside a DataChunk or a parent vector. */
function readVector(r: Reader, t: LType, count: number): Cell[] {
  const vectorType = r.opt(90, () => r.uint(), VectorType.FLAT);
  switch (vectorType) {
    case VectorType.FLAT:
      break;
    case VectorType.CONSTANT: {
      const [one = null] = readVector(r, t, 1);
      return Array.from({ length: count }, () => one);
    }
    case VectorType.SEQUENCE: {
      r.expect(91, "sequence start");
      const start = r.svarint();
      r.expect(92, "sequence increment");
      const step = r.svarint();
      return Array.from({ length: count }, (_, i) => format(t, start + step * BigInt(i)));
    }
    case VectorType.DICTIONARY: {
      r.expect(91, "dictionary selection");
      const sel = r.blob();
      r.expect(92, "dictionary size");
      const dict = readVector(r, t, r.uint());
      const view = new DataView(sel.buffer, sel.byteOffset, sel.byteLength);
      return Array.from({ length: count }, (_, i) => dict[view.getUint32(i * 4, true)] ?? null);
    }
    default:
      throw new Unsupported(`vector type ${vectorType}`);
  }
  r.opt(99, () => r.uint(), 0);

  r.expect(100, "has_validity_mask");
  const mask = r.bool() ? (r.expect(101, "validity"), r.blob()) : null;
  const valid = (i: number) => !mask || ((mask[i >> 3] ?? 0) >> (i & 7)) & 1;
  const rows = <C extends Cell>(read: (row: number) => C) =>
    Array.from({ length: count }, (_, row) => (valid(row) ? read(row) : null));

  const kind = physical(t);
  const width = WIDTH[kind];
  if (width) {
    r.expect(102, "data");
    const data = r.blob();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return rows((row) => format(t, readFixed(kind, view, row * width)));
  }
  switch (kind) {
    case "varchar": {
      r.expect(102, "strings");
      const text = t.id === TypeId.VARCHAR || t.id === TypeId.CHAR;
      const decoder = new TextDecoder();
      const strings = r.list(() => r.blob());
      return rows((row) => {
        const bytes = strings[row] ?? new Uint8Array();
        return { text: text ? decoder.decode(bytes) : blobText(bytes), quoted: true };
      });
    }
    case "struct": {
      const types = t.children ?? [];
      r.expect(103, "struct children");
      const children = r.list((i) => r.object("a struct field vector", () => readVector(r, types[i]?.[1] ?? t, count)));
      return rows((row) => {
        const fields = types.map(([name], i): [string, Cell] => [name, children[i]?.[row] ?? null]);
        if (t.id !== TypeId.UNION) return { fields };
        // A union's first field is its tag, naming which member holds the value.
        const member = fields[Number(show(fields[0]?.[1] ?? null) ?? 0) + 1];
        return member ? { fields: [member] } : null;
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
      return rows((row) => {
        const [offset = 0, length = 0] = entries[row] ?? [];
        const items = child.slice(offset, offset + length);
        if (t.id !== TypeId.MAP) return items;
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
      return rows((row) => child.slice(row * size, (row + 1) * size));
    }
    default:
      throw new Unsupported(`vectors of type ${t.name}`);
  }
}

/** A DataChunk object. Without `withData` it stops after the row count and types, leaving the reader mid-object. */
export function readChunk(r: Reader, withData: boolean, names: string[] = []): ChunkView {
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
  const cells = Array.from({ length: Math.min(rows, MAX_ROWS) }, (_, row) => vectors.map((v) => show(v[row] ?? null)));
  return { rows, columns, cells };
}

// ---------------------------------------------------------------------------------------------------------------
// Constant values
// ---------------------------------------------------------------------------------------------------------------

/** A Value object: its type (only at the root), a NULL flag, then the value itself. */
export function readValue(r: Reader, type?: LType): Cell {
  return r.object("a value", () => {
    const rootType = r.opt(100, () => readType(r), null);
    const t = type ?? rootType;
    if (!t) throw new Unsupported("a value without a type");
    r.expect(101, "is_null");
    return r.bool() ? null : readValueBody(r, t);
  });
}

function readValueBody(r: Reader, t: LType): Cell {
  const kind = physical(t);
  if (kind === "list" || kind === "struct") {
    r.expect(102, "value children");
    const children = r.object("value children", () => {
      r.expect(100, "children");
      return r.list((i) => readValue(r, (kind === "list" ? t.child : t.children?.[i]?.[1]) ?? t));
    });
    return kind === "list" ? children : { fields: (t.children ?? []).map(([n], i) => [n, children[i] ?? null]) };
  }
  r.expect(102, "value");
  switch (kind) {
    case "varchar":
      return { text: r.string(), quoted: true };
    case "bool":
      return format(t, r.bool());
    case "i8":
    case "i16":
    case "i32":
    case "i64":
      return format(t, r.svarint());
    case "u8":
    case "u16":
    case "u32":
    case "u64":
      return format(t, r.uvarint());
    case "i128":
    case "u128": {
      const upper = kind === "i128" ? r.svarint() : r.uvarint();
      return format(t, (upper << 64n) + r.uvarint());
    }
    case "f32":
      return format(t, r.f32());
    case "f64":
      return format(t, r.f64());
    default:
      throw new Unsupported(`constant values of type ${t.name}`);
  }
}
