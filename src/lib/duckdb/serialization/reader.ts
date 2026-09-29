/**
 * Reads DuckDB's BinarySerializer format: little-endian u16 field ids, LEB128 integers, length-prefixed strings,
 * and 0xFFFF closing each object. Fields come in id order; fields left at their default are left out.
 */

const TERMINATOR = 0xffff;
const MAX_VARINT_SHIFT = 140n;

/** The bytes end before the value does. */
export class Truncated extends Error {}
/** A structure this reader doesn't know how to skip over. */
export class Unsupported extends Error {}

const fieldName = (id: number) => (id === TERMINATOR ? "the end of the object" : `field ${id}`);
const decoder = new TextDecoder();

export class Reader {
  pos: number;
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** A second reader from the same position, to peek ahead without moving this one. */
  fork(): Reader {
    return new Reader(this.bytes, this.pos, this.end);
  }

  raw(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new Truncated(`needs ${n} more bytes at offset ${this.pos}`);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.raw(1)[0] ?? 0;
  }

  u16(): number {
    this.raw(2);
    return this.view.getUint16(this.pos - 2, true);
  }

  f32(): number {
    this.raw(4);
    return this.view.getFloat32(this.pos - 4, true);
  }

  f64(): number {
    this.raw(8);
    return this.view.getFloat64(this.pos - 8, true);
  }

  uvarint(): bigint {
    return this.leb128(false);
  }

  svarint(): bigint {
    return this.leb128(true);
  }

  private leb128(signed: boolean): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (shift > MAX_VARINT_SHIFT) throw new Unsupported("varint is too long");
    } while (b & 0x80);
    if (signed && b & 0x40) result -= 1n << shift;
    return result;
  }

  uint(): number {
    return Number(this.uvarint());
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  blob(): Uint8Array {
    return this.raw(this.uint());
  }

  string(): string {
    return decoder.decode(this.blob());
  }

  /** Consumes field `id` if it comes next. */
  field(id: number): boolean {
    if (this.pos + 2 > this.end || this.view.getUint16(this.pos, true) !== id) return false;
    this.pos += 2;
    return true;
  }

  /** An optional field: its value when present, `fallback` when it was left out as a default. */
  opt<R>(id: number, read: () => R, fallback: R): R {
    return this.field(id) ? read() : fallback;
  }

  expect(id: number, what: string): void {
    const got = this.u16();
    if (got !== id) throw new Unsupported(`expected field ${id} (${what}) but found ${fieldName(got)}`);
  }

  close(what: string): void {
    const got = this.u16();
    if (got !== TERMINATOR) throw new Unsupported(`${what} has ${fieldName(got)} this viewer doesn't know`);
  }

  object<R>(what: string, read: () => R): R {
    const value = read();
    this.close(what);
    return value;
  }

  /** A pointer: a presence flag, then the object. */
  nullable<R>(read: () => R): R | null {
    return this.bool() ? read() : null;
  }

  list<R>(read: (i: number) => R): R[] {
    return Array.from({ length: this.uint() }, (_, i) => read(i));
  }

  /** A pair, as DuckDB writes map entries: an object with fields 0 and 1. */
  pair<K, V>(first: () => K, second: () => V): [K, V] {
    return this.object("a pair", () => {
      this.expect(0, "first");
      const k = first();
      this.expect(1, "second");
      return [k, second()];
    });
  }
}

export const quoteName = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`);
export const qualified = (schema: string, name: string) => (schema ? `${schema}.${name}` : name);
