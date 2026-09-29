import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeEntry, isIncomplete, parseWal, walChecksum, type WalFile } from "../src/lib/duckdb/wal";

const tables = new Map([["main.customers", ["id", "name"]]]);
const bytes = new Uint8Array(await readFile("public/orders.duckdb.wal"));
const byType = (wal: WalFile, type: string) => wal.entries.filter((e) => e.typeName === type);

describe("orders.duckdb.wal", () => {
  const wal = parseWal(bytes, { name: "orders.duckdb.wal", tables });

  it("frames every entry and verifies its checksum", () => {
    expect(wal.version).toBe(2);
    expect(wal.commits).toBe(11);
    expect(wal.entries.at(-1)?.end).toBe(bytes.length);
    for (const [i, e] of wal.entries.entries()) {
      if (i > 0) expect(e.start).toBe(wal.entries[i - 1]?.end);
    }
  });

  it("marks the torn last transaction as incomplete, and nothing else", () => {
    const incomplete = wal.entries.filter(isIncomplete);
    expect(incomplete.map((e) => e.typeName)).toEqual(["USE_TABLE", "INSERT_TUPLE"]);
    expect(incomplete[0]?.problems).toEqual([expect.stringMatching(/^not committed/)]);
    expect(incomplete[1]?.problems[0]).toMatch(/^truncated: the entry is [\d,]+ bytes but only [\d,]+ are in the file/);
  });

  it("rebuilds CREATE TABLE with defaults and constraints", () => {
    const [create] = byType(wal, "CREATE_TABLE");
    if (!create) throw new Error("no CREATE TABLE");
    expect(create.summary).toBe("CREATE TABLE shop.orders (7 columns)");
    const sql = decodeEntry(wal, create).sql ?? "";
    expect(sql).toContain("id INTEGER NOT NULL");
    expect(sql).toContain("status ENUM('new', 'paid', 'shipped') DEFAULT 'new'");
    expect(sql).toContain("shipping STRUCT(city VARCHAR, express BOOLEAN)");
    expect(sql).toContain("PRIMARY KEY (id)");
  });

  it("decodes inserted rows, including NULLs and nested values", () => {
    const [first] = byType(wal, "INSERT_TUPLE");
    if (!first) throw new Error("no INSERT");
    expect(first.summary).toBe("INSERT 2 rows into shop.orders");
    const chunk = decodeEntry(wal, first).chunk;
    expect(chunk?.columns.map((c) => c.name)).toEqual([
      "id",
      "customer_id",
      "amount",
      "placed",
      "status",
      "tags",
      "shipping",
    ]);
    expect(chunk?.cells).toEqual([
      ["1", "7", "12.50", "2024-05-01 10:00:00", "paid", "['gift']", "{'city': 'Oslo', 'express': true}"],
      ["2", "9", null, null, "new", null, null],
    ]);
  });

  it("names the rows and columns updates and deletes touch", () => {
    const [update] = byType(wal, "UPDATE_TUPLE");
    const [del] = byType(wal, "DELETE_TUPLE");
    if (!update || !del) throw new Error("no UPDATE or DELETE");
    expect(update.summary).toBe("UPDATE 5 rows of shop.orders (status)");
    expect(decodeEntry(wal, update).chunk?.cells[0]).toEqual(["shipped", "0"]);
    expect(del.summary).toBe("DELETE 21 rows from shop.orders");
    expect(decodeEntry(wal, del).chunk?.cells.map((r) => r[0])).toContain("100");
  });

  it("uses the database's column names for tables created before the log", () => {
    const insert = byType(wal, "INSERT_TUPLE").find((e) => e.table === "main.customers");
    if (!insert) throw new Error("no insert into customers");
    const chunk = decodeEntry(wal, insert).chunk;
    expect(chunk?.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(chunk?.cells).toEqual([["51", "customer 51"]]);
  });

  it("summarizes catalog changes", () => {
    const summaries = wal.entries.map((e) => e.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        "CREATE SCHEMA shop",
        "ALTER TABLE main.customers RENAME name TO full_name",
        "CREATE VIEW shop.big_orders",
        "CREATE SEQUENCE shop.order_ids",
        "SEQUENCE shop.order_ids counter = 2501",
      ]),
    );
    const view = byType(wal, "CREATE_VIEW")[0];
    if (!view) throw new Error("no view");
    expect(decodeEntry(wal, view).sql).toBe(
      "CREATE VIEW shop.big_orders AS SELECT * FROM shop.orders WHERE amount > 1000;",
    );
  });

  it("still shows a truncated insert's row count and columns", () => {
    const torn = wal.entries.at(-1);
    if (!torn) throw new Error("no entries");
    const detail = decodeEntry(wal, torn);
    expect(detail.chunk?.rows).toBe(500);
    expect(detail.chunk?.columns).toHaveLength(7);
    expect(detail.stopped).toMatch(/ends before its data does/);
  });
});

describe("damaged logs", () => {
  it("stops at an entry whose checksum doesn't match, like DuckDB's replay", () => {
    const copy = bytes.slice();
    const good = parseWal(copy, { name: "x.wal" });
    const target = good.entries.find((e) => e.typeName === "UPDATE_TUPLE");
    if (!target) throw new Error("no UPDATE");
    const at = target.payloadStart + 20;
    copy[at] = (copy[at] ?? 0) ^ 0xff;
    const wal = parseWal(copy, { name: "x.wal" });
    const damaged = wal.entries.find((e) => e.start === target.start);
    expect(damaged?.problems[0]).toMatch(/^checksum mismatch/);
    const rest = wal.entries.at(-1);
    expect(rest?.typeName).toBe("UNREADABLE");
    expect(rest?.problems[0]).toMatch(/after a damaged entry/);
    expect(wal.entries.filter((e) => e.start > target.start).every(isIncomplete)).toBe(true);
  });

  it("marks a torn frame header", () => {
    const wal = parseWal(bytes.subarray(0, 36 + 7), { name: "x.wal" });
    expect(wal.entries.at(-1)?.summary).toBe("Torn entry header");
    expect(wal.entries.at(-1)?.problems[0]).toMatch(/^truncated/);
  });

  it("rejects bytes that aren't a WAL", () => {
    const wal = parseWal(new TextEncoder().encode("<!doctype html>"), { name: "x.wal" });
    expect(wal.entries).toHaveLength(1);
    expect(wal.notes[0]).toMatch(/doesn't start like a DuckDB WAL/);
  });

  it("lists only what was read of a log larger than the read limit", () => {
    const wal = parseWal(bytes.subarray(0, 50_000), { name: "x.wal", size: bytes.length });
    expect(wal.entries.some(isIncomplete)).toBe(false);
    expect(wal.notes.at(-1)).toMatch(/^Only the first 50,000/);
  });
});

describe("walChecksum", () => {
  it("matches DuckDB's checksum for word-aligned and ragged payloads", () => {
    const wal = parseWal(bytes, { name: "x.wal" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const framed = wal.entries.filter((e) => e.typeName !== "WAL_VERSION" && !isIncomplete(e));
    const lengths = new Set(framed.map((e) => (e.payloadEnd - e.payloadStart) % 8));
    expect(lengths.size).toBeGreaterThan(1);
    for (const e of framed) {
      expect(walChecksum(bytes.subarray(e.payloadStart, e.payloadEnd))).toBe(view.getBigUint64(e.start + 8, true));
    }
  });
});
