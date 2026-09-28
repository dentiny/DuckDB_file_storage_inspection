import type { StorageRow } from "./catalog";
import { BLOCK_HEADER_SIZE, blockStart, type BlockUsage, type DatabaseHeader } from "./header";

/** The first read from a block's end; each further read goes back four times as far. */
const FIRST_STEP = 4096;
/** Reads and bytes spent measuring blocks before the rest keep their upper bound. */
const MAX_READS = 2048;
const MAX_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 8;

type Read = (start: number, end: number) => Promise<ArrayBuffer>;

/**
 * Bytes in use in each block's payload, found by scanning back from the block's end to its last non-zero byte.
 * DuckDB zero-fills the rest of a block after its last segment, and storage_info only gives where segments start.
 * Scans stop at the last segment's start, so a full block costs one small read. Shared blocks go first.
 */
export async function measureBlocks(
  header: DatabaseHeader,
  storage: StorageRow[][],
  usage: BlockUsage | null,
  read: Read,
): Promise<Map<number, number>> {
  const lastStart = new Map<number, number>();
  for (const rows of storage) {
    for (const r of rows) {
      if (r.blockId < 0 || !r.persistent) continue;
      lastStart.set(r.blockId, Math.max(lastStart.get(r.blockId) ?? 0, r.blockOffset));
    }
  }
  const shared = (b: number) => (usage?.multiUse.get(b) ?? 1) > 1;
  const queue = [...lastStart.keys()].sort((a, b) => Number(shared(b)) - Number(shared(a)) || a - b);
  const payload = header.blockAllocSize - BLOCK_HEADER_SIZE;
  const used = new Map<number, number>();
  let reads = 0;
  let bytes = 0;

  const measure = async (block: number) => {
    const floor = lastStart.get(block) ?? 0;
    const base = blockStart(header, block) + BLOCK_HEADER_SIZE;
    let end = payload;
    let step = FIRST_STEP;
    while (end > floor) {
      if (reads >= MAX_READS || bytes >= MAX_BYTES) return;
      const start = Math.max(floor, end - step);
      reads += 1;
      bytes += end - start;
      const chunk = new Uint8Array(await read(base + start, base + end));
      let i = chunk.length - 1;
      while (i >= 0 && chunk[i] === 0) i--;
      if (i >= 0) {
        used.set(block, start + i + 1);
        return;
      }
      end = start;
      step *= 4;
    }
    used.set(block, floor);
  };

  let next = 0;
  const worker = async () => {
    while (next < queue.length) await measure(queue[next++] as number);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return used;
}
