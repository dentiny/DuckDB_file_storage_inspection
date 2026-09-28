import { getContext, setContext } from "svelte";
import type { DuckDBModel, Piece, RowGroupInfo } from "./duckdb/model";

export interface Popover {
  piece: Piece;
  x: number;
  y: number;
  /** Whether clicking where the pointer is opens the piece's row group. */
  opensRowGroup: boolean;
}

export interface Initial {
  table: string | null;
  rg: number | null;
  col: string | null;
}

/** The loaded file plus everything the user has selected in it. */
export class Inspector {
  readonly model: DuckDBModel;
  /** The URL or path being shown; files picked in the browser have no shareable link. */
  readonly source: string | null;
  /** How the file was opened, e.g. "DuckDB-Wasm v1.5.4 · 420 ms". */
  readonly loadSummary: string;

  /** The table whose row groups are listed. */
  selectedTable = $state(0);
  selectedRg = $state<number | null>(null);
  selectedLeaf = $state<number | null>(null);
  showAllRowGroups = $state(false);
  /** Row group hovered in the list, outlined in the file map. */
  hoveredRg = $state.raw<RowGroupInfo | null>(null);
  /** Bumped when a row group is selected from outside the list, so the list scrolls to it. */
  revealTick = $state(0);
  /** Whether the last reveal should also scroll the page, when the list may be off screen. Read untracked. */
  revealInPage = false;
  popover = $state.raw<Popover | null>(null);

  constructor(model: DuckDBModel, source: string | null, initial: Initial, loadSummary: string) {
    this.model = model;
    this.source = source;
    this.loadSummary = loadSummary;
    const byRows = model.tables.reduce(
      (best, t) => (t.def.rows > (model.tables[best]?.def.rows ?? -1) ? t.index : best),
      0,
    );
    const named = model.tables.findIndex((t) => t.qualified === initial.table);
    this.selectedTable = named === -1 ? byRows : named;
    const table = model.tables[this.selectedTable];
    this.selectedRg = initial.rg !== null && table?.rowGroups.some((g) => g.rg === initial.rg) ? initial.rg : null;
    const leaf = table?.leaves.find((l) => model.leaves[l]?.name === initial.col);
    this.selectedLeaf = leaf ?? null;
    if (this.selectedRg !== null) this.revealTick += 1;
  }

  get table() {
    const table = this.model.tables[this.selectedTable];
    if (!table) throw new Error(`no table ${this.selectedTable}`);
    return table;
  }

  get selectedGroup(): RowGroupInfo | null {
    return this.selectedRg === null ? null : (this.table.rowGroups.find((g) => g.rg === this.selectedRg) ?? null);
  }

  selectTable(table: number): void {
    if (table === this.selectedTable) return;
    this.selectedTable = table;
    this.selectedRg = null;
    this.showAllRowGroups = false;
    if (this.selectedLeaf !== null && this.model.leaves[this.selectedLeaf]?.table !== table) this.selectedLeaf = null;
  }

  toggleRowGroup(table: number, rg: number, { reveal = false } = {}): void {
    const open = this.selectedTable === table && this.selectedRg === rg;
    this.selectTable(table);
    this.selectedRg = open ? null : rg;
    if (reveal) this.reveal(false);
  }

  openRowGroup(table: number, rg: number): void {
    this.selectTable(table);
    this.selectedRg = rg;
    this.reveal(true);
  }

  private reveal(inPage: boolean): void {
    this.revealInPage = inPage;
    this.revealTick += 1;
  }

  toggleLeaf(leaf: number): void {
    const table = this.model.leaves[leaf]?.table;
    if (table !== undefined) this.selectTable(table);
    this.selectedLeaf = this.selectedLeaf === leaf ? null : leaf;
    this.showAllRowGroups = false;
  }

  showPopover(piece: Piece | null, event: MouseEvent, opensRowGroup = false): void {
    this.popover = piece ? { piece, x: event.clientX, y: event.clientY, opensRowGroup } : null;
  }

  hidePopover(): void {
    this.popover = null;
  }
}

const KEY = Symbol("inspector");

export function setInspector(inspector: Inspector): void {
  setContext(KEY, inspector);
}

export function getInspector(): Inspector {
  return getContext<Inspector>(KEY);
}
