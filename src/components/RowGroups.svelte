<script lang="ts">
  import RowGroupItem from "./RowGroupItem.svelte";
  import { formatNumber } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";

  const inspector = getInspector();
  const { model } = inspector;
  const table = $derived(inspector.table);
  const maxSize = $derived(Math.max(1, ...(table?.rowGroups ?? []).map((g) => g.bytes)));
  let list: HTMLDivElement;

  // Selections made outside the list (file map, column panel, a shared link) scroll it to the open row group.
  $effect(() => {
    if (!inspector.revealTick) return;
    const open = list.querySelector<HTMLElement>(".open");
    if (!open) return;
    list.scrollTop = open.offsetTop - 26;
    if (inspector.revealInPage) open.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
</script>

<section>
  <h2>
    Row groups <small
      >{table
        ? `${formatNumber(table.rowGroups.length)} in ${table.qualified} · click one, or a segment in the file`
        : "no tables to list"}</small
    >
  </h2>
  {#if model.tables.length > 1}
    <div class="tabs" role="tablist" aria-label="Tables">
      {#each model.tables as t (t.index)}
        <button
          type="button"
          role="tab"
          class="mono"
          aria-selected={inspector.selectedTable === t.index}
          onclick={() => inspector.selectTable(t.index)}
        >
          {t.qualified} <span class="muted">{formatNumber(t.rowGroups.length)}</span>
        </button>
      {/each}
    </div>
  {/if}
  <div class="list" bind:this={list}>
    <div class="header">
      <span></span><span>rg</span><span>rows</span><span></span><span class="r">size</span>
    </div>
    {#each table?.rowGroups ?? [] as group (`${group.table}:${group.rg}`)}
      <RowGroupItem {group} {maxSize} />
    {:else}
      <p class="empty">{table ? "No rows are checkpointed into this table." : "No tables could be read."}</p>
    {/each}
  </div>
</section>

<style>
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }

  .tabs button {
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
  }

  .tabs button[aria-selected="true"] {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .list {
    position: relative;
    max-height: 640px;
    overflow: hidden auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    font-size: 12px;
    scrollbar-gutter: stable;
  }

  .header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: grid;
    grid-template-columns: var(--rg-columns);
    gap: 10px;
    align-items: center;
    height: 26px;
    padding: 0 12px;
    border-bottom: 1px solid var(--line-soft);
    background: var(--surface);
    font-size: 11px;
    color: var(--text-4);
  }

  .list {
    --rg-columns: 14px 36px 150px minmax(0, 1fr) 64px;
  }

  .r {
    text-align: right;
  }

  .empty {
    margin: 0;
    padding: 12px;
    color: var(--text-4);
  }

  @media (max-width: 700px) {
    .list {
      --rg-columns: 12px 28px minmax(0, 1fr) 58px;
      max-height: 70vh;
    }
    .header {
      gap: 8px;
      padding: 0 10px;
    }
    .header > :nth-child(4) {
      display: none;
    }
  }
</style>
