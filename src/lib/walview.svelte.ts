import { walFor } from "./duckdb/load";
import type { DuckDBModel } from "./duckdb/model";
import { walFromFile, type WalBytes } from "./duckdb/source";
import { parseWal, type WalFile } from "./duckdb/wal";

/** A write-ahead log and the entry opened in it; with or without the database it belongs to. */
export class WalView {
  wal = $state.raw<WalFile | null>(null);
  /** Index of the entry whose contents are shown. */
  selected = $state<number | null>(null);
  /** Whether the log could be looked for; a file picked in the browser can't see its sibling `.wal`. */
  readonly searched: boolean;
  /** The database the log belongs to, which supplies column names; null when the log is shown on its own. */
  readonly model: DuckDBModel | null;

  constructor(wal: WalFile | null, searched: boolean, model: DuckDBModel | null) {
    this.wal = wal;
    this.searched = searched;
    this.model = model;
  }

  toggle(index: number): void {
    this.selected = this.selected === index ? null : index;
  }

  load(bytes: WalBytes): void {
    this.selected = null;
    this.wal = this.model ? walFor(bytes, this.model) : parseWal(bytes.bytes, { name: bytes.name, size: bytes.size });
  }

  async open(file: File): Promise<void> {
    this.load(await walFromFile(file));
  }
}
