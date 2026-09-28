<script lang="ts">
  import ChunkRow from "./ChunkRow.svelte";
  import { leafColor } from "../lib/colors";
  import { formatBytes, formatNumber } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import type { RowGroupInfo } from "../lib/duckdb/model";

  let { group, maxSize }: { group: RowGroupInfo; maxSize: number } = $props();

  const inspector = getInspector();
  const open = $derived(inspector.selectedTable === group.table && inspector.selectedRg === group.rg);
  const maxChunk = $derived(Math.max(1, ...group.chunks.map((c) => c.bytes)));
  const segments = $derived(group.chunks.reduce((sum, c) => sum + c.segments.length, 0));
  const blocks = $derived(
    group.blocks.length > 12 ? `${group.blocks.slice(0, 12).join(", ")}, …` : group.blocks.join(", ") || "none",
  );

  /** One gradient instead of an element per chunk: tables with hundreds of columns would otherwise overflow the bar. */
  const gradient = $derived.by(() => {
    const total = group.bytes || 1;
    let at = 0;
    const stops = group.chunks.map((c) => {
      const from = (at / total) * 100;
      at += c.bytes;
      return `${leafColor(c.leaf, inspector.selectedLeaf)} ${from}% ${(at / total) * 100}%`;
    });
    return `linear-gradient(to right, ${stops.join(", ")})`;
  });

  function hover(event: PointerEvent, entering: boolean) {
    if (event.pointerType === "mouse") inspector.hoveredRg = entering ? group : null;
  }
</script>

<div class="item" class:open>
  <button
    type="button"
    class="summary"
    aria-expanded={open}
    onclick={() => inspector.toggleRowGroup(group.table, group.rg)}
    onpointerenter={(event) => hover(event, true)}
    onpointerleave={(event) => hover(event, false)}
  >
    <span class="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="mono">{group.rg}</span>
    <span class="mono muted">{formatNumber(group.firstRow)}–{formatNumber(group.firstRow + group.numRows - 1)}</span>
    <span class="bar"><span style:width="{(group.bytes / maxSize) * 100}%" style:background={gradient}></span></span>
    <span class="mono r">{formatBytes(group.bytes)}</span>
  </button>
  {#if open}
    <div class="body">
      <div class="meta">
        <span><span class="k">rows</span> <span class="mono">{formatNumber(group.numRows)}</span></span>
        <span><span class="k">segments</span> <span class="mono">{formatNumber(segments)}</span></span>
        <span><span class="k">blocks</span> <span class="mono">{blocks}</span></span>
      </div>
      {#each group.chunks as chunk (chunk.leaf)}
        <ChunkRow {chunk} {maxChunk} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .item {
    border-bottom: 1px solid var(--line-soft);
  }

  .item:last-child {
    border: 0;
  }

  .summary {
    display: grid;
    grid-template-columns: var(--rg-columns);
    gap: 10px;
    align-items: center;
    width: 100%;
    height: 30px;
    padding: 0 12px;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .summary:hover {
    background: var(--surface-2);
  }

  .open .summary {
    background: var(--accent-soft);
  }

  .chevron {
    font-size: 10px;
    color: var(--text-4);
  }

  .r {
    text-align: right;
  }

  .bar {
    height: 8px;
    min-width: 0;
  }

  .bar > span {
    display: block;
    height: 100%;
    border-radius: 1px;
  }

  .body {
    padding: 8px 12px 12px 36px;
    background: #fcfcfd;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    margin-bottom: 6px;
  }

  .k {
    color: var(--text-4);
  }

  @media (max-width: 700px) {
    .summary {
      gap: 8px;
      padding: 0 10px;
    }
    .bar {
      display: none;
    }
    .body {
      padding: 8px 10px 10px;
    }
  }
</style>
