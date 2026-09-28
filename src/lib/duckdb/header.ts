/** The main header and the two database headers each take one 4 KB slot at the start of the file. */
export const HEADER_SIZE = 4096;
/** Blocks start after the three header slots. */
export const BLOCKS_START = 3 * HEADER_SIZE;
/** Every block (and header) starts with an 8-byte checksum. */
export const BLOCK_HEADER_SIZE = 8;
/** Metadata blocks are split into this many sub-blocks, chained by 8-byte pointers. */
export const METADATA_BLOCK_COUNT = 64;
const INVALID_BLOCK = -1;
const ENCRYPTED_FLAG = 1n;
/** Sub-blocks to follow before giving up on a free list, so a corrupt pointer can't loop forever. */
const MAX_FREE_LIST_SUB_BLOCKS = 4096;

/** A pointer into a metadata block: block id in the low 56 bits, sub-block index in the high 8. */
export interface MetaPointer {
  block: number;
  index: number;
}

export interface DatabaseHeader {
  /** Byte offset of this header slot. */
  offset: number;
  checksum: bigint;
  /** Bumped on every checkpoint; the header with the higher iteration is the active one. */
  iteration: number;
  metaBlock: MetaPointer | null;
  freeList: MetaPointer | null;
  blockCount: number;
  blockAllocSize: number;
  vectorSize: number;
  serializationCompatibility: number;
}

export interface FileHeader {
  checksum: bigint;
  storageVersion: number;
  flags: bigint[];
  encrypted: boolean;
  /** e.g. "v1.5.5". */
  libraryVersion: string;
  /** Git hash of the DuckDB build that created the file. */
  sourceId: string;
  headers: [DatabaseHeader, DatabaseHeader];
  active: 0 | 1;
}

/** What the active header's free list says about every block. */
export interface BlockUsage {
  free: number[];
  /** Blocks shared by several segments, with how many segments point into each. */
  multiUse: Map<number, number>;
}

export class NotDuckDBError extends Error {}

export function metaPointer(raw: bigint): MetaPointer | null {
  if (BigInt.asIntN(64, raw) === BigInt(INVALID_BLOCK)) return null;
  return { block: Number(raw & 0x00ff_ffff_ffff_ffffn), index: Number(raw >> 56n) };
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function databaseHeader(view: DataView, offset: number): DatabaseHeader {
  const u64 = (at: number) => view.getBigUint64(offset + at, true);
  return {
    offset,
    checksum: u64(0),
    iteration: Number(u64(8)),
    metaBlock: metaPointer(u64(16)),
    freeList: metaPointer(u64(24)),
    blockCount: Number(u64(32)),
    blockAllocSize: Number(u64(40)),
    vectorSize: Number(u64(48)),
    serializationCompatibility: Number(u64(56)),
  };
}

/** Parses the first 12 KB of a database file: the main header and both database headers. */
export function parseHeaders(buffer: ArrayBuffer): FileHeader {
  if (buffer.byteLength < BLOCKS_START) throw new NotDuckDBError("the file is shorter than DuckDB's headers");
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(8, 12));
  if (magic !== "DUCK") throw new NotDuckDBError(`no DUCK magic bytes at offset 8`);
  const flags = [0, 1, 2, 3].map((i) => view.getBigUint64(20 + i * 8, true));
  const headers: [DatabaseHeader, DatabaseHeader] = [
    databaseHeader(view, HEADER_SIZE),
    databaseHeader(view, 2 * HEADER_SIZE),
  ];
  return {
    checksum: view.getBigUint64(0, true),
    storageVersion: Number(view.getBigUint64(12, true)),
    flags,
    encrypted: ((flags[0] ?? 0n) & ENCRYPTED_FLAG) !== 0n,
    libraryVersion: cString(bytes.subarray(52, 84)),
    sourceId: cString(bytes.subarray(84, 116)),
    headers,
    active: headers[1].iteration > headers[0].iteration ? 1 : 0,
  };
}

export function activeHeader(file: FileHeader): DatabaseHeader {
  return file.headers[file.active];
}

/** Byte offset where a block's checksum starts. */
export function blockStart(header: DatabaseHeader, block: number): number {
  return BLOCKS_START + block * header.blockAllocSize;
}

/** Bytes per metadata sub-block: the block payload split 64 ways, rounded down to 8 bytes. */
export function metadataSubBlockSize(header: DatabaseHeader): number {
  return Math.floor((header.blockAllocSize - BLOCK_HEADER_SIZE) / METADATA_BLOCK_COUNT / 8) * 8;
}

export function subBlockStart(header: DatabaseHeader, pointer: MetaPointer): number {
  return blockStart(header, pointer.block) + BLOCK_HEADER_SIZE + pointer.index * metadataSubBlockSize(header);
}

type Read = (start: number, end: number) => Promise<ArrayBuffer>;

/** Reads a chain of metadata sub-blocks as one stream, the way DuckDB's MetadataReader does. */
class MetadataReader {
  private buffer = new DataView(new ArrayBuffer(0));
  private at = 0;
  private next: MetaPointer | null;
  private hops = 0;

  constructor(
    private readonly header: DatabaseHeader,
    private readonly read: Read,
    start: MetaPointer,
  ) {
    this.next = start;
  }

  private async advance(): Promise<void> {
    if (!this.next) throw new Error("metadata chain ended early");
    if (++this.hops > MAX_FREE_LIST_SUB_BLOCKS) throw new Error("metadata chain is too long");
    const start = subBlockStart(this.header, this.next);
    this.buffer = new DataView(await this.read(start, start + metadataSubBlockSize(this.header)));
    this.next = metaPointer(this.buffer.getBigUint64(0, true));
    this.at = 8;
  }

  private async bytes(n: number): Promise<DataView> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      if (this.at >= this.buffer.byteLength) await this.advance();
      const take = Math.min(n - filled, this.buffer.byteLength - this.at);
      out.set(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + this.at, take), filled);
      filled += take;
      this.at += take;
    }
    return new DataView(out.buffer);
  }

  async u64(): Promise<bigint> {
    return (await this.bytes(8)).getBigUint64(0, true);
  }

  async i64(): Promise<number> {
    return Number((await this.bytes(8)).getBigInt64(0, true));
  }

  async u32(): Promise<number> {
    return (await this.bytes(4)).getUint32(0, true);
  }
}

/** Reads the free list the active header points to: free block ids, then blocks shared by several segments. */
export async function readBlockUsage(file: FileHeader, read: Read): Promise<BlockUsage> {
  const header = activeHeader(file);
  if (!header.freeList) return { free: [], multiUse: new Map() };
  const reader = new MetadataReader(header, read, header.freeList);
  const inRange = (block: number) => Number.isInteger(block) && block >= 0 && block < header.blockCount;

  const freeCount = Number(await reader.u64());
  if (freeCount > header.blockCount) throw new Error(`free list claims ${freeCount} of ${header.blockCount} blocks`);
  const free: number[] = [];
  for (let i = 0; i < freeCount; i++) {
    const block = await reader.i64();
    if (!inRange(block)) throw new Error(`free list names block ${block}`);
    free.push(block);
  }
  const multiUseCount = Number(await reader.u64());
  if (multiUseCount > header.blockCount) throw new Error(`free list claims ${multiUseCount} shared blocks`);
  const multiUse = new Map<number, number>();
  for (let i = 0; i < multiUseCount; i++) {
    const block = await reader.i64();
    const uses = await reader.u32();
    if (!inRange(block)) throw new Error(`free list names shared block ${block}`);
    multiUse.set(block, uses);
  }
  return { free, multiUse };
}
