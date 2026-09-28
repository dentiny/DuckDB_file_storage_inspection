<script lang="ts">
  import Efficiency from "./Efficiency.svelte";
  import { getInspector } from "../lib/inspector.svelte";
  import { formatBytes, formatNumber } from "../lib/format";
  import { shareUrl, toQuery } from "../lib/share";

  const inspector = getInspector();
  const { model } = inspector;
  const { header, file } = model;

  const rows = model.tables.reduce((sum, t) => sum + t.def.rows, 0);
  const rowGroups = model.tables.reduce((sum, t) => sum + t.rowGroups.length, 0);
  const others = [
    [model.views.length, "view"],
    [model.indexes.length, "index"],
    [model.sequences.length, "sequence"],
  ] as const;
  const extras = others
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${formatNumber(n)} ${what}${n === 1 ? "" : what === "index" ? "es" : "s"}`)
    .join(" · ");

  const stats = [
    { label: "Size", value: formatBytes(model.fileSize) },
    { label: "Tables", value: formatNumber(model.tables.length), note: extras },
    { label: "Rows", value: formatNumber(rows) },
    { label: "Row groups", value: formatNumber(rowGroups) },
    {
      label: "Blocks",
      value: `${formatNumber(header.blockCount)} × ${formatBytes(header.blockAllocSize)}`,
      note: model.usage ? `${formatNumber(model.blocks.free.length)} free` : "free list unreadable",
    },
  ];

  let copied = $state(false);

  async function copyLink() {
    const { source, selectedRg, selectedLeaf } = inspector;
    if (source === null) return;
    const col = selectedLeaf === null ? null : (model.leaves[selectedLeaf]?.name ?? null);
    const query = toQuery({ db: source, table: inspector.table.qualified, rg: selectedRg, col });
    await navigator.clipboard.writeText(shareUrl(query, location));
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<section aria-label="File summary">
  <header>
    <h2 class="mono">{model.name}</h2>
    <span class="loaded">{inspector.loadSummary}</span>
    {#if inspector.source !== null}
      <button type="button" onclick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
    {/if}
  </header>
  <dl>
    {#each stats as stat (stat.label)}
      <div>
        <dt>{stat.label}</dt>
        <dd>{stat.value}</dd>
        {#if stat.note}<dd class="note">{stat.note}</dd>{/if}
      </div>
    {/each}
    <div class="created">
      <dt>Created by</dt>
      <dd class="mono">DuckDB {file.libraryVersion} <span class="muted">{file.sourceId}</span></dd>
      <dd class="note">storage version {file.storageVersion} · checkpoint {formatNumber(header.iteration)}</dd>
    </div>
  </dl>
  <Efficiency />
</section>

<style>
  section {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
  }

  h2 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loaded {
    font-size: 12px;
    color: var(--text-3);
  }

  button {
    margin-left: auto;
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
  }

  button:hover {
    border-color: #d1d5db;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr)) minmax(0, 1.6fr);
    gap: 12px;
    margin: 0;
    padding: 12px 16px;
  }

  dt {
    font-size: 11.5px;
    color: var(--text-3);
  }

  dd {
    margin: 2px 0 0;
    overflow: hidden;
    font-size: 15px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  dd.note {
    margin-top: 1px;
    font-size: 11.5px;
    font-weight: 400;
    color: var(--text-4);
  }

  .created dd:not(.note) {
    margin-top: 4px;
    font-size: 12.5px;
    font-weight: 500;
  }

  @media (max-width: 700px) {
    header {
      padding: 10px 12px;
    }
    .loaded {
      order: 3;
      flex-basis: 100%;
    }
    dl {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      padding: 12px;
    }
    .created {
      grid-column: 1 / -1;
    }
  }
</style>
