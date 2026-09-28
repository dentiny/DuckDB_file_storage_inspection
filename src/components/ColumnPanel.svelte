<script lang="ts">
  import { leafColor } from "../lib/colors";
  import { formatBytes, formatNumber, formatValue, percent } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import { chunkAt, leafAt } from "../lib/duckdb/model";
  import { orderOf, rangePositions, type Bounds } from "../lib/duckdb/stats";

  /** Long tables show this many row groups until asked for the rest. */
  const MAX_ROWS = 100;

  let { leaf }: { leaf: number } = $props();

  const inspector = getInspector();
  const { model } = inspector;

  const column = $derived(leafAt(model.leaves, leaf));
  const rowGroups = $derived(model.tables[column.table]?.rowGroups ?? []);
  const bytes = $derived(model.leafBytes[leaf] ?? 0);
  const chunks = $derived(rowGroups.map((g) => chunkAt(g, column.column)));
  const segments = $derived(chunks.reduce((sum, c) => sum + c.segments.length, 0));
  const compressions = $derived([...new Set(chunks.flatMap((c) => c.compressions))]);
  const bounds = $derived(chunks.map((c) => c.bounds));
  const order = $derived(orderOf(bounds));
  const position = $derived(rangePositions(bounds.filter((b): b is Bounds => b !== null)));
  const missing = $derived(bounds.filter((b) => !b).length);
  const orderText = $derived(
    {
      single: "",
      missing: `${formatNumber(missing)} of ${formatNumber(bounds.length)} row groups have no min/max`,
      constant: "same range in every row group",
      sorted: "sorted: filters on it skip row groups",
      overlapping: "ranges overlap across row groups",
    }[order],
  );
  const shown = $derived(inspector.showAllRowGroups ? rowGroups : rowGroups.slice(0, MAX_ROWS));

  function open(event: MouseEvent, rg: number) {
    event.stopPropagation();
    inspector.openRowGroup(column.table, rg);
  }
</script>

<div class="panel">
  <div class="head">
    <b class="mono">{column.path}</b>
    {#if orderText}<span class:sorted={order === "sorted"}>{orderText}</span>{/if}
  </div>
  <div class="facts">
    <span><span class="k">size</span> {formatBytes(bytes)} ({percent(bytes, model.fileSize)} of file)</span>
    <span><span class="k">segments</span> {formatNumber(segments)}</span>
    <span><span class="k">compression</span> {compressions.join(", ") || "–"}</span>
  </div>
  <div class="table mono">
    <div class="row header">
      <span>rg</span><span>min</span><span>max</span><span>{position ? "range" : ""}</span>
      <span class="r">nulls</span><span class="r">size</span>
    </div>
    {#each shown as g, i (g.rg)}
      {@const chunk = chunks[i]}
      {@const b = bounds[i]}
      <button
        type="button"
        class="row"
        class:selected={inspector.selectedRg === g.rg}
        title="Open row_group[{g.rg}]"
        onclick={(event) => open(event, g.rg)}
      >
        <span class="muted">{g.rg}</span>
        <span>{b ? formatValue(b.min, column.type) : "–"}</span>
        <span>{b ? formatValue(b.max, column.type) : "–"}</span>
        <span class="range">
          {#if b && position}
            {@const lo = position(b.min)}
            <span
              style:left="{lo * 100}%"
              style:width="{Math.max(0.8, (position(b.max) - lo) * 100)}%"
              style:background={leafColor(leaf, inspector.selectedLeaf)}
            ></span>
          {/if}
        </span>
        <span class="r muted">{chunk?.hasNull === null ? "–" : chunk?.hasNull ? "some" : "none"}</span>
        <span class="r">{formatBytes(chunk?.bytes ?? 0)}</span>
      </button>
    {/each}
    {#if shown.length < rowGroups.length}
      <button
        type="button"
        class="more"
        onclick={(event) => {
          event.stopPropagation();
          inspector.showAllRowGroups = true;
        }}>Show all {formatNumber(rowGroups.length)} row groups</button
      >
    {/if}
  </div>
</div>

<style>
  .panel {
    margin: 4px 12px 8px 30px;
    padding: 10px 12px;
    border-radius: var(--radius);
    outline: 1px solid #e0e7ff;
    background: var(--surface);
    font-family: var(--font-sans);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin-bottom: 8px;
    font-size: 12.5px;
  }

  .head span {
    font-size: 12px;
    color: var(--text-4);
  }

  .head .sorted {
    color: var(--ok);
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 18px;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .k {
    color: var(--text-4);
  }

  .table {
    max-height: 420px;
    overflow-y: auto;
    font-size: 11.5px;
    scrollbar-gutter: stable;
  }

  .row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) minmax(0, 1fr) minmax(80px, 1.1fr) 44px 64px;
    gap: 10px;
    align-items: center;
    width: 100%;
    height: 22px;
    padding: 0 4px;
    border: 0;
    border-radius: 4px;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .r {
    text-align: right;
  }

  .row:hover,
  .row.selected {
    background: var(--accent-soft);
  }

  .row.header {
    position: sticky;
    top: 0;
    background: var(--surface);
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--text-4);
    cursor: default;
  }

  .range {
    position: relative;
    height: 6px;
    border-radius: 1px;
    background: var(--line-soft);
  }

  .range > span {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 1px;
  }

  .more {
    margin-top: 4px;
    padding: 4px;
    border: 0;
    background: none;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }

  @media (max-width: 700px) {
    .panel {
      margin: 4px 0 8px;
    }
    .row {
      grid-template-columns: 26px minmax(0, 1fr) minmax(0, 1fr) 52px;
      grid-template-areas: "rg min max size" ". bar bar bar";
      row-gap: 3px;
      height: auto;
      padding: 4px;
    }
    .row > :nth-child(1) {
      grid-area: rg;
    }
    .row > :nth-child(2) {
      grid-area: min;
    }
    .row > :nth-child(3) {
      grid-area: max;
    }
    .row > :nth-child(4) {
      grid-area: bar;
    }
    .row > :nth-child(5) {
      display: none;
    }
    .row > :nth-child(6) {
      grid-area: size;
    }
    .row.header > :nth-child(4) {
      display: none;
    }
  }
</style>
