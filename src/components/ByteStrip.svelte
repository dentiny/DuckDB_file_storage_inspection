<script lang="ts">
  import { pieceColor } from "../lib/colors";
  import { getInspector } from "../lib/inspector.svelte";
  import { paintDominant, spanAt } from "../lib/paint";
  import type { Piece } from "../lib/duckdb/model";
  import { rowGroupOf } from "../lib/popover";

  interface Span {
    start: number;
    end: number;
  }

  interface Props {
    /** Pieces inside `from`..`to`, sorted by start. */
    pieces: Piece[];
    from: number;
    to: number;
    label: string;
    /** Offsets drawn as seams, e.g. block boundaries. */
    seams?: number[];
    /** Outlined spans, e.g. every segment of the open row group; a row group is scattered over many blocks. */
    selected?: Span[];
    /** Outlined from outside, e.g. while hovering a row group in the list. */
    highlighted?: Span[];
    /** Called for clicks on pieces that belong to a row group. Without it, clicks show the piece's details. */
    onpick?: (piece: Piece) => void;
  }

  let { pieces, from, to, label, seams = [], selected = [], highlighted = [], onpick }: Props = $props();

  const inspector = getInspector();
  let canvas: HTMLCanvasElement;
  let width = $state(0);
  let height = $state(0);
  let hovered = $state.raw<Piece | null>(null);

  /** Pieces are painted once per size and column selection; hovering only redraws outlines over this layer. */
  const base = $derived.by(() => {
    if (!width || !height) return null;
    const dpr = devicePixelRatio || 1;
    const layer = new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr));
    const ctx = layer.getContext("2d");
    if (!ctx) return null;
    const selectedLeaf = inspector.selectedLeaf;
    const x = (offset: number) => ((offset - from) / (to - from)) * width;
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(0, 0, layer.width, layer.height);
    paintDominant(ctx, pieces, from, to, layer.width, layer.height, (p) => pieceColor(p, selectedLeaf));
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "rgb(255 255 255 / 85%)";
    for (const p of pieces) if (x(p.end) - x(p.start) > 4) ctx.fillRect(x(p.start), 0, 1, height);
    ctx.fillStyle = "#fff";
    const gap = seams.length > 1 ? x(seams[1] ?? 0) - x(seams[0] ?? 0) : Infinity;
    if (gap > 3) for (const s of seams) ctx.fillRect(x(s) - 0.75, 0, 1.5, height);
    return layer;
  });

  $effect(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx || !base) return;
    const dpr = devicePixelRatio || 1;
    canvas.width = base.width;
    canvas.height = base.height;
    ctx.drawImage(base, 0, 0);
    ctx.scale(dpr, dpr);
    const x = (offset: number) => ((offset - from) / (to - from)) * width;
    const outlines: [Span[], string][] = [
      [selected, "#4f46e5"],
      [hovered ? [hovered] : highlighted, "#111827"],
    ];
    ctx.lineWidth = 2;
    for (const [spans, color] of outlines) {
      ctx.strokeStyle = color;
      for (const span of spans) {
        if (span.end <= from || span.start >= to) continue;
        ctx.strokeRect(x(span.start) + 1, 1, Math.max(x(span.end) - x(span.start) - 2, 2), height - 2);
      }
    }
  });

  function pick(event: MouseEvent): Piece | null {
    const rect = canvas.getBoundingClientRect();
    const offset = from + ((event.clientX - rect.left) / rect.width) * (to - from);
    return spanAt(pieces, offset, ((to - from) / rect.width) * 2);
  }

  function onpointermove(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    hovered = pick(event);
    inspector.showPopover(hovered, event, !!onpick && !!hovered && rowGroupOf(hovered) !== null);
  }

  function onpointerleave(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    hovered = null;
    inspector.hidePopover();
  }

  function onclick(event: MouseEvent) {
    event.stopPropagation();
    const piece = pick(event);
    if (onpick && piece && rowGroupOf(piece)) {
      inspector.hidePopover();
      onpick(piece);
      return;
    }
    hovered = piece;
    inspector.showPopover(piece, event);
  }
</script>

<div class="frame" bind:clientWidth={width} bind:clientHeight={height}>
  <canvas bind:this={canvas} class:clickable={!!onpick} aria-label={label} {onpointermove} {onpointerleave} {onclick}
  ></canvas>
</div>

<style>
  .frame {
    height: 40px;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 3px;
    cursor: crosshair;
  }

  canvas.clickable {
    cursor: pointer;
  }

  @media (max-width: 700px) {
    .frame {
      height: 36px;
    }
  }
</style>
