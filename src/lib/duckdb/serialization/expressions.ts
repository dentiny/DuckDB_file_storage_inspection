import { quoteName, Unsupported, type Reader } from "./reader";
import { readType } from "./types";
import { readValue, show } from "./values";

/** ExpressionClass values from DuckDB's `expression_type.hpp`, for the classes column defaults and CHECKs use. */
const ExpressionClass = { CAST: 3, COLUMN_REF: 4, COMPARISON: 5, CONJUNCTION: 6, CONSTANT: 7, FUNCTION: 9 } as const;
const COMPARISON: Record<number, string> = { 25: "=", 26: "<>", 27: "<", 28: ">", 29: "<=", 30: ">=" };
const CONJUNCTION_OR = 28;

/** A ParsedExpression as SQL, e.g. a column's DEFAULT or a CHECK constraint. */
export function readExpression(r: Reader): string {
  return r.object("an expression", () => {
    r.expect(100, "expression class");
    const cls = r.uint();
    r.expect(101, "expression type");
    const type = r.uint();
    r.opt(102, () => r.string(), "");
    r.opt(103, () => r.uvarint(), 0n);
    const child = (id: number) => r.opt(id, () => r.nullable(() => readExpression(r)) ?? "NULL", "NULL");
    const children = (id: number) => r.opt(id, () => r.list(() => r.nullable(() => readExpression(r)) ?? "NULL"), []);
    switch (cls) {
      case ExpressionClass.CONSTANT:
        r.expect(200, "constant");
        return show(readValue(r), true) ?? "NULL";
      case ExpressionClass.COLUMN_REF:
        return r
          .opt(200, () => r.list(() => r.string()), [])
          .map(quoteName)
          .join(".");
      case ExpressionClass.CAST: {
        const from = child(200);
        r.expect(201, "cast type");
        const to = readType(r);
        const tryCast = r.opt(202, () => r.bool(), false);
        return `${tryCast ? "TRY_CAST" : "CAST"}(${from} AS ${to.name})`;
      }
      case ExpressionClass.FUNCTION: {
        const name = r.opt(200, () => r.string(), "");
        const schema = r.opt(201, () => r.string(), "");
        const args = children(202);
        if (r.field(203) || r.field(204)) throw new Unsupported("function filters and ORDER BY");
        const distinct = r.opt(205, () => r.bool(), false);
        const operator = r.opt(206, () => r.bool(), false);
        r.opt(207, () => r.bool(), false);
        r.opt(208, () => r.string(), "");
        if (operator && args.length === 2) return `(${args[0]} ${name} ${args[1]})`;
        return `${schema ? `${schema}.` : ""}${name}(${distinct ? "DISTINCT " : ""}${args.join(", ")})`;
      }
      case ExpressionClass.COMPARISON: {
        const left = child(200);
        const right = child(201);
        return `(${left} ${COMPARISON[type] ?? "?"} ${right})`;
      }
      case ExpressionClass.CONJUNCTION:
        return `(${children(200).join(type === CONJUNCTION_OR ? " OR " : " AND ")})`;
      default:
        throw new Unsupported(`expressions of class ${cls}`);
    }
  });
}
