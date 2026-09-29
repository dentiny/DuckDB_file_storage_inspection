import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLocalPath, serveLocalFile } from "../server/local-files";
import { isLocalPath, nameOf, resolveInput, urlSource, walUrl } from "../src/lib/duckdb/source";
import { parseStats } from "../src/lib/duckdb/stats";
import { fromQuery, toQuery } from "../src/lib/share";

describe("resolveInput", () => {
  const base = "http://localhost:5173/";

  it("sends local paths to the local file server", () => {
    expect(isLocalPath("~/data/app.duckdb")).toBe(true);
    expect(isLocalPath("https://example.com/app.duckdb")).toBe(false);
    expect(resolveInput(" /tmp/a b.duckdb ", base)).toBe("http://localhost:5173/@local?path=%2Ftmp%2Fa%20b.duckdb");
    expect(resolveInput("file:///tmp/x.db", base)).toBe("http://localhost:5173/@local?path=%2Ftmp%2Fx.db");
  });

  it("makes relative URLs absolute, since DuckDB-Wasm fetches from its worker", () => {
    expect(resolveInput("sensors.duckdb", base)).toBe("http://localhost:5173/sensors.duckdb");
    expect(resolveInput("https://example.com/f.duckdb", base)).toBe("https://example.com/f.duckdb");
  });

  it("finds the write-ahead log next to a URL or a local path", () => {
    expect(walUrl("https://example.com/db/app.duckdb?x=1")).toBe("https://example.com/db/app.duckdb.wal?x=1");
    expect(walUrl(resolveInput("/tmp/app.duckdb", base))).toBe(
      "http://localhost:5173/@local?path=%2Ftmp%2Fapp.duckdb.wal",
    );
  });

  it("names files by their last path segment", () => {
    expect(nameOf("~/data/app.duckdb")).toBe("app.duckdb");
    expect(nameOf("https://x.com/a/b.db?download=1")).toBe("b.db");
  });
});

describe("share query", () => {
  it("round-trips the database, table, row group and column", () => {
    const selection = { db: "~/data/app.duckdb", table: "main.sensors", rg: 3, col: "ts" };
    expect(fromQuery(toQuery(selection))).toEqual(selection);
  });

  it("ignores a malformed row group", () => {
    expect(fromQuery("?db=x.duckdb&rg=abc")).toEqual({ db: "x.duckdb", table: null, rg: null, col: null });
    expect(fromQuery("?rg=1")).toBeNull();
  });
});

describe("parseStats", () => {
  it("reads typed min/max and the null flag", () => {
    expect(parseStats("[Min: -3, Max: 12][Has Null: true, Has No Null: true]", "INTEGER")).toEqual({
      bounds: { min: -3, max: 12 },
      hasNull: true,
    });
    const strings = parseStats(
      "[Min: Berlin, Max: Tokyo, Has Unicode: false, Max String Length: 6][Has Null: false, Has No Null: true]",
      "VARCHAR",
    );
    expect(strings.bounds).toEqual({ min: "Berlin", max: "Tokyo" });
    const ts = parseStats("[Min: 2024-01-01 00:00:00, Max: 2024-03-26 07:59:00][Has Null: false]", "TIMESTAMP");
    expect(ts.bounds?.min).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(parseStats("[Has Null: false, Has No Null: true]", "VALIDITY").bounds).toBeNull();
    const list =
      "[[Min: \\xFF\\xFF, Max: , Has Unicode: false, Max String Length: 0][Has Null: false]][Has Null: false]";
    expect(parseStats(list, "VARCHAR[]").bounds).toBeNull();
  });
});

describe("local file server", async () => {
  const server = createServer((req, res) => void serveLocalFile(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = (p: string) => `http://127.0.0.1:${port}/@local?path=${encodeURIComponent(p)}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves byte ranges of a database with its WAL size", async () => {
    const source = await urlSource(url(path.resolve("public/sensors.duckdb")));
    expect(source.byteLength).toBeGreaterThan(1024 * 1024);
    expect(source.walSize).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(source.head, 8, 4))).toBe("DUCK");
    expect((await source.read(100, 200)).byteLength).toBe(100);
  });

  it("serves the write-ahead log next to a database, and nothing when there is none", async () => {
    const orders = await urlSource(url(path.resolve("public/orders.duckdb")), "orders.duckdb");
    expect(orders.walSize).toBeGreaterThan(0);
    const wal = await orders.readWal();
    expect(wal?.name).toBe("orders.duckdb.wal");
    expect(wal?.size).toBe(orders.walSize);
    expect([...(wal?.bytes.subarray(0, 2) ?? [])]).toEqual([0x64, 0x00]);
    const sensors = await urlSource(url(path.resolve("public/sensors.duckdb")));
    expect(await sensors.readWal()).toBeNull();
    expect((await fetch(url(path.resolve("package.json") + ".wal"))).status).toBe(404);
  });

  it("refuses files that aren't DuckDB databases", async () => {
    const res = await fetch(url(path.resolve("package.json")));
    expect(res.status).toBe(415);
    expect((await fetch(url("/no/such/file.duckdb"))).status).toBe(404);
  });

  it("expands ~ and relative paths", () => {
    expect(resolveLocalPath("~/x.duckdb")).toMatch(/\/x\.duckdb$/);
    expect(resolveLocalPath("./a.duckdb", "/tmp")).toBe("/tmp/a.duckdb");
  });
});
