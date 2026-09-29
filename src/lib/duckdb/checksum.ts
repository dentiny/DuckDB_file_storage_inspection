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

/**
 * DuckDB's checksum over a block, a header or a WAL entry: 64-bit words multiplied by a constant and XORed, the
 * leftover bytes hashed. Blocks and headers store it in their first 8 bytes, over the rest.
 */
export function checksum(b: Uint8Array): bigint {
  let result = 5381n;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const words = Math.floor(b.length / 8);
  for (let i = 0; i < words; i++) result ^= mul(view.getBigUint64(i * 8, true), 0xbf58476d1ce4e5b9n);
  if (b.length % 8) result ^= checksumRemainder(b.subarray(words * 8));
  return result;
}
