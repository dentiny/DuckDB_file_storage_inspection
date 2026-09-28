import { describe, expect, it } from "vitest";
import { readEfficiency } from "../src/lib/duckdb/efficiency";
import type { SegmentPiece } from "../src/lib/duckdb/model";
import { describePiece } from "../src/lib/popover";
import { loadFixture } from "./helpers";

describe("sensors.duckdb", async () => {
  const model = await loadFixture("public/sensors.duckdb");

  it("reads the catalog", () => {
    expect(model.tables.map((t) => t.qualified)).toEqual(["logs.events", "main.sensors"]);
    expect(model.views.map((v) => v.name)).toEqual(["hot_sensors"]);
    expect(model.sequences.map((s) => s.name)).toEqual(["event_ids"]);
    expect(model.indexes.map((i) => `${i.table}: ${i.name}`)).toEqual(["events: PRIMARY KEY(id)"]);
    const sensors = model.tables[1];
    expect(sensors?.def.rows).toBe(400_000);
    expect(sensors?.rowGroups.map((g) => g.numRows)).toEqual([122_880, 122_880, 122_880, 31_360]);
    expect(sensors?.rowGroups[2]?.firstRow).toBe(245_760);
  });

  it("places every piece inside the file without overlaps", () => {
    for (const [i, piece] of model.pieces.entries()) {
      expect(piece.start).toBeGreaterThanOrEqual(0);
      expect(piece.end).toBeLessThanOrEqual(model.fileSize);
      expect(piece.end).toBeGreaterThan(piece.start);
      const next = model.pieces[i + 1];
      if (next) expect(next.start).toBeGreaterThanOrEqual(piece.end);
    }
  });

  it("accounts for every block with the free list", () => {
    const { total, free, metadata, unknown } = model.blocks;
    expect(total).toBe(44);
    expect(free).toHaveLength(21);
    expect(metadata).toEqual([30]);
    // The primary key's ART index is the only thing storage_info doesn't list.
    expect(unknown).toHaveLength(1);
    expect(model.usage?.multiUse.size).toBeGreaterThan(0);
  });

  it("measures where each block's last segment ends", () => {
    const segments = model.pieces.filter((p): p is SegmentPiece => p.kind === "segment" || p.kind === "validity");
    expect(segments.every((p) => p.extent !== "blockEnd")).toBe(true);
    const slack = model.pieces.filter((p) => p.kind === "slack");
    expect(slack.length).toBeGreaterThan(0);
    const small = model.tables[0]?.rowGroups[0]?.chunks[0];
    expect(small?.bytes).toBeLessThan(64 * 1024);
  });

  it("puts long strings in overflow blocks", () => {
    const events = model.tables[0];
    const message = events?.rowGroups[0]?.chunks[2];
    expect(message?.parts.some((p) => p.kind === "overflow")).toBe(true);
  });

  it("finds sorted columns and free space", () => {
    const checks = Object.fromEntries(readEfficiency(model).map((c) => [c.label, c]));
    expect(checks.Sorted?.columns).toEqual(expect.arrayContaining(["main.sensors.event_id", "main.sensors.ts"]));
    expect(checks.Compact?.passed).toBe(false);
  });

  it("describes a segment with its rows and min/max", () => {
    const piece = model.tables[1]?.rowGroups[1]?.chunks[0]?.parts[0];
    if (!piece) throw new Error("no segment");
    const content = describePiece(piece, model);
    expect(content.title).toBe("Column segment");
    expect(content.where).toBe("main.sensors · row_group[1]");
    const rows = Object.fromEntries(content.rows);
    expect(rows.Rows).toBe("122,880 – 245,759");
    expect(rows.min).toBe("1,122,880");
  });
});
