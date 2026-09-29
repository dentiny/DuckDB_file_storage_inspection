import { quoteName, Unsupported, type Reader } from "./reader";

/** A LogicalType as far as the viewer needs it: its id, display name, and what nested types carry. */
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

/** LogicalTypeId values from DuckDB's `types.hpp`. */
export const TypeId = {
  BOOLEAN: 10,
  INTEGER: 13,
  BIGINT: 14,
  DATE: 15,
  TIME: 16,
  TIMESTAMP_S: 17,
  TIMESTAMP_MS: 18,
  TIMESTAMP: 19,
  TIMESTAMP_NS: 20,
  DECIMAL: 21,
  CHAR: 24,
  VARCHAR: 25,
  TIMESTAMP_TZ: 32,
  TIME_TZ: 34,
  TIME_NS: 35,
  UHUGEINT: 49,
  UUID: 54,
  STRUCT: 100,
  LIST: 101,
  MAP: 102,
  ENUM: 104,
  UNION: 107,
  ARRAY: 108,
} as const;

const NAMES: Record<number, string> = {
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

/** How a type's values are laid out in a vector. */
export type Physical =
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

const PHYSICAL: Record<number, Physical> = {
  10: "bool",
  11: "i8",
  12: "i16",
  13: "i32",
  15: "i32",
  14: "i64",
  16: "i64",
  17: "i64",
  18: "i64",
  19: "i64",
  20: "i64",
  32: "i64",
  35: "i64",
  28: "u8",
  29: "u16",
  30: "u32",
  31: "u64",
  34: "u64",
  51: "u64",
  50: "i128",
  54: "i128",
  49: "u128",
  22: "f32",
  23: "f64",
  27: "interval",
  24: "varchar",
  25: "varchar",
  26: "varchar",
  36: "varchar",
  39: "varchar",
  60: "varchar",
  100: "struct",
  107: "struct",
  101: "list",
  102: "list",
  108: "array",
};

/** Bytes per value for fixed-width layouts. */
export const WIDTH: Partial<Record<Physical, number>> = {
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

export function physical(t: LType): Physical {
  if (t.id === TypeId.DECIMAL) {
    const w = t.width ?? 18;
    return w <= 4 ? "i16" : w <= 9 ? "i32" : w <= 18 ? "i64" : "i128";
  }
  if (t.id === TypeId.ENUM) {
    const n = t.values?.length ?? 0;
    return n <= 0xff ? "u8" : n <= 0xffff ? "u16" : "u32";
  }
  const kind = PHYSICAL[t.id];
  if (!kind) throw new Unsupported(`values of type ${t.name}`);
  return kind;
}

/** A LogicalType object: its id, then optional ExtraTypeInfo for types with parameters or children. */
export function readType(r: Reader): LType {
  return r.object("a type", () => {
    r.expect(100, "type id");
    const t: LType = { id: r.uint(), name: "" };
    let alias = "";
    if (r.field(101)) {
      r.nullable(() =>
        r.object("type info", () => {
          r.expect(100, "type info kind");
          const kind = r.uint();
          alias = r.opt(101, () => r.string(), "");
          if (r.field(103)) throw new Unsupported("extension type info");
          alias ||= readTypeInfo(r, t, kind);
        }),
      );
    }
    t.name = alias || typeName(t);
    return t;
  });
}

/** Fills in `t` from ExtraTypeInfo of the given kind; returns a user type's name, which stands in for its own. */
function readTypeInfo(r: Reader, t: LType, kind: number): string {
  switch (kind) {
    case 1:
      return "";
    case 2:
      t.width = r.opt(200, () => r.uint(), 0);
      t.scale = r.opt(201, () => r.uint(), 0);
      return "";
    case 3:
      r.opt(200, () => r.string(), "");
      return "";
    case 4:
      r.expect(200, "list child type");
      t.child = readType(r);
      return "";
    case 5:
      t.children = r.opt(
        200,
        () =>
          r.list(() =>
            r.pair(
              () => r.string(),
              () => readType(r),
            ),
          ),
        [],
      );
      return "";
    case 6:
      r.expect(200, "enum size");
      r.uint();
      r.expect(201, "enum values");
      t.values = r.list(() => r.string());
      return "";
    case 7: {
      const name = r.opt(200, () => r.string(), "");
      r.opt(201, () => r.string(), "");
      const schema = r.opt(202, () => r.string(), "");
      if (r.field(203) || r.field(204)) throw new Unsupported("user type modifiers");
      return schema ? `${schema}.${name}` : name;
    }
    case 9:
      r.expect(200, "array child type");
      t.child = readType(r);
      t.size = r.opt(201, () => r.uint(), 0);
      return "";
    default:
      throw new Unsupported(`type info kind ${kind}`);
  }
}

function typeName(t: LType): string {
  const base = NAMES[t.id] ?? `TYPE_${t.id}`;
  switch (t.id) {
    case TypeId.DECIMAL:
      return `DECIMAL(${t.width},${t.scale})`;
    case TypeId.LIST:
      return `${t.child?.name ?? "?"}[]`;
    case TypeId.ARRAY:
      return `${t.child?.name ?? "?"}[${t.size}]`;
    case TypeId.MAP: {
      const [k, v] = t.child?.children ?? [];
      return `MAP(${k?.[1].name ?? "?"}, ${v?.[1].name ?? "?"})`;
    }
    case TypeId.STRUCT:
    case TypeId.UNION: {
      const fields = (t.children ?? []).filter(([n], i) => !(t.id === TypeId.UNION && i === 0 && n === ""));
      return `${base}(${fields.map(([n, c]) => `${quoteName(n)} ${c.name}`).join(", ")})`;
    }
    case TypeId.ENUM: {
      const values = t.values ?? [];
      const shown = values.slice(0, 4).map((v) => `'${v.replaceAll("'", "''")}'`);
      return `ENUM(${shown.join(", ")}${values.length > 4 ? ", …" : ""})`;
    }
    default:
      return base;
  }
}
