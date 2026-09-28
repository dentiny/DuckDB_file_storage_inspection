<script lang="ts">
  import ColumnName from "./ColumnName.svelte";
  import ColumnPanel from "./ColumnPanel.svelte";
  import { leafColor } from "../lib/colors";
  import { formatBytes } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import type { CatalogEntry } from "../lib/duckdb/catalog";

  type Line =
    | { kind: "table"; table: number }
    | { kind: "column"; leaf: number; last: boolean }
    | { kind: "close" }
    | { kind: "entry"; keyword: string; entry: CatalogEntry };

  const inspector = getInspector();
  const { model } = inspector;
  const lines: Line[] = [
    ...model.tables.flatMap((t): Line[] => [
      { kind: "table", table: t.index },
      ...t.leaves.map((leaf, i): Line => ({ kind: "column", leaf, last: i === t.leaves.length - 1 })),
      { kind: "close" },
    ]),
    ...model.indexes.map((entry): Line => ({ kind: "entry", keyword: "INDEX", entry })),
    ...model.views.map((entry): Line => ({ kind: "entry", keyword: "CREATE VIEW", entry })),
    ...model.sequences.map((entry): Line => ({ kind: "entry", keyword: "CREATE SEQUENCE", entry })),
  ];
  const totalBytes = model.leafBytes.reduce((a, b) => a + b, 0) || 1;
</script>

<section>
  <h2>Catalog <small>size on disk · click a column to find it in the file</small></h2>
  <div class="schema mono">
    {#each lines as line, n (n)}
      {#if line.kind === "table"}
        {@const table = model.tables[line.table]}
        <button
          type="button"
          class="line"
          class:current={inspector.selectedTable === line.table && model.tables.length > 1}
          onclick={() => inspector.selectTable(line.table)}
          title="List the row groups of {table?.qualified}"
        >
          <span class="n">{n + 1}</span>
          <span class="code">
            <span class="kw">CREATE TABLE&nbsp;</span><ColumnName name={table?.qualified ?? ""} /><span>&nbsp;(</span>
          </span>
          <span class="size"><span class="value">{formatBytes(table?.bytes ?? 0)}</span></span>
        </button>
      {:else if line.kind === "column"}
        {@const leaf = model.leaves[line.leaf]}
        {@const color = leafColor(line.leaf, inspector.selectedLeaf)}
        {@const bytes = model.leafBytes[line.leaf] ?? 0}
        <button
          type="button"
          class="line leaf"
          aria-label="Column {leaf?.path}, {formatBytes(bytes)}"
          aria-pressed={inspector.selectedLeaf === line.leaf}
          class:selected={inspector.selectedLeaf === line.leaf}
          onclick={() => inspector.toggleLeaf(line.leaf)}
        >
          <span class="n">{n + 1}</span>
          <span class="code" style:padding-left="2ch">
            <ColumnName name={leaf?.name ?? ""} />
            <span class="ty">&nbsp;{leaf?.type}</span>
            <span>{line.last ? "" : ","}</span>
          </span>
          <span class="size">
            <span class="bar"><span style:width="{(bytes / totalBytes) * 100}%" style:background={color}></span></span>
            <span class="swatch" style:background={color}></span>
            <span class="value">{formatBytes(bytes)}</span>
          </span>
        </button>
        {#if inspector.selectedLeaf === line.leaf}
          <ColumnPanel leaf={line.leaf} />
        {/if}
      {:else if line.kind === "close"}
        <div class="line">
          <span class="n">{n + 1}</span>
          <span class="code">);</span>
        </div>
      {:else}
        <div class="line" title={line.entry.sql}>
          <span class="n">{n + 1}</span>
          <span class="code">
            <span class="kw">{line.keyword}&nbsp;</span>
            <ColumnName
              name={line.entry.table
                ? `${line.entry.name} ON ${line.entry.table}`
                : `${line.entry.schema}.${line.entry.name}`}
            />
            <span>;</span>
          </span>
        </div>
      {/if}
    {/each}
  </div>
</section>

<style>
  .schema {
    padding: 6px 0;
    border-radius: var(--radius);
    outline: 1px solid var(--line);
    background: var(--surface-2);
    font-size: 12.5px;
  }

  .line {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) 130px;
    align-items: center;
    width: 100%;
    height: 24px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
  }

  button.line {
    cursor: pointer;
  }

  button.line:hover,
  .selected {
    background: var(--accent-soft);
  }

  .selected,
  .current {
    box-shadow: inset 3px 0 0 #818cf8;
  }

  .n {
    padding-right: 10px;
    color: #d1d5db;
    text-align: right;
  }

  .code {
    display: flex;
    min-width: 0;
    padding-right: 12px;
    overflow: hidden;
    white-space: pre;
  }

  .code > :global(*) {
    flex: none;
  }

  .code > :global(.name) {
    flex: 0 1 auto;
  }

  .code :global(.name) {
    font-weight: 600;
  }

  .kw {
    color: #e11d48;
  }

  /* Types give way before names do. */
  .ty {
    flex: 0 1000 auto !important;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #7c3aed;
  }

  .size {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding-right: 12px;
    font-size: 11px;
    color: var(--text-4);
  }

  .bar {
    position: relative;
    flex: 1;
    height: 4px;
    border-radius: 1px;
    background: #eceef2;
  }

  .bar > span {
    position: absolute;
    inset: 0 auto 0 0;
    min-width: 1px;
    border-radius: 1px;
  }

  .size .swatch {
    display: none;
    width: 8px;
    height: 8px;
  }

  .value {
    width: 60px;
    text-align: right;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    .line {
      grid-template-columns: 26px minmax(0, 1fr) 64px;
    }
    .bar {
      display: none;
    }
    .size .swatch {
      display: block;
    }
    .value {
      width: auto;
    }
  }
</style>
