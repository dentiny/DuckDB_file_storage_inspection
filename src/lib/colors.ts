import type { Piece } from "./duckdb/model";
import { KINDS } from "./kinds";

/** Muted hues cycled per column; a validity mask is a lighter tint of its column's segments. */
const HUES = [215, 28, 150, 330, 262, 45, 180, 0];

/** A column's color. With a column selected, the others fade to gray so it stands out in the file map. */
export function leafColor(leaf: number, selectedLeaf: number | null, light = false): string {
  const hue = HUES[leaf % HUES.length];
  if (selectedLeaf === null) return `hsl(${hue} 45% ${light ? 87 : 74}%)`;
  if (leaf === selectedLeaf) return `hsl(${hue} 60% ${light ? 80 : 60}%)`;
  return light ? "#eef0f3" : "#dfe2e6";
}

export function pieceColor(p: Piece, selectedLeaf: number | null): string {
  if (p.kind === "segment" || p.kind === "validity" || p.kind === "overflow") {
    return leafColor(p.chunk.leaf, selectedLeaf, p.kind !== "segment");
  }
  // The older of the two database headers is the one the next checkpoint overwrites.
  if (p.kind === "dbHeader" && !p.active) return "#dde3fb";
  return KINDS[p.kind].color;
}
