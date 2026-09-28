import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  activeHeader,
  BLOCKS_START,
  metadataSubBlockSize,
  metaPointer,
  NotDuckDBError,
  parseHeaders,
  readBlockUsage,
} from "../src/lib/duckdb/header";

describe("parseHeaders", async () => {
  const bytes = new Uint8Array(await readFile("public/sensors.duckdb"));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = parseHeaders(buffer.slice(0, BLOCKS_START));
  const header = activeHeader(file);

  it("reads the main header", () => {
    expect(file.storageVersion).toBe(64);
    expect(file.libraryVersion).toMatch(/^v1\.\d+\.\d+/);
    expect(file.encrypted).toBe(false);
  });

  it("picks the database header with the higher iteration", () => {
    const other = file.headers[1 - file.active];
    expect(header.iteration).toBeGreaterThan(other?.iteration ?? 0);
    expect(header.blockAllocSize).toBe(256 * 1024);
    expect(header.vectorSize).toBe(2048);
    expect(BLOCKS_START + header.blockCount * header.blockAllocSize).toBe(bytes.byteLength);
    expect(metadataSubBlockSize(header)).toBe(4088);
  });

  it("follows the free list pointer into a metadata block", async () => {
    const usage = await readBlockUsage(file, async (start, end) => buffer.slice(start, end));
    expect(usage.free).toHaveLength(21);
    expect([...usage.multiUse.values()].every((n) => n > 1)).toBe(true);
  });

  it("rejects files without the DUCK magic", () => {
    expect(() => parseHeaders(new ArrayBuffer(BLOCKS_START))).toThrow(NotDuckDBError);
  });
});

describe("metaPointer", () => {
  it("splits the block id from the sub-block index", () => {
    expect(metaPointer(0x0800_0000_0000_0007n)).toEqual({ block: 7, index: 8 });
    expect(metaPointer(0xffff_ffff_ffff_ffffn)).toBeNull();
  });
});
