<script lang="ts">
  import WalEntryDetail from "./WalEntryDetail.svelte";
  import { formatBytes, formatNumber } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import { walFor } from "../lib/duckdb/load";
  import { MAX_WAL_BYTES } from "../lib/duckdb/source";
  import { isIncomplete, type WalEntry } from "../lib/duckdb/wal";

  /** Long logs list this many entries until asked for the rest. */
  const MAX_LISTED = 400;

  const inspector = getInspector();
  const wal = $derived(inspector.wal);
  const entries = $derived(wal?.entries ?? []);
  const incomplete = $derived(entries.filter(isIncomplete).length);
  const changes = $derived(entries.filter((e) => e.category !== "commit" && e.typeName !== "WAL_VERSION").length);
  let showAll = $state(false);
  const listed = $derived(showAll ? entries : entries.slice(0, MAX_LISTED));
  let error = $state("");
  let list = $state<HTMLDivElement>();

  // Opening an entry from the strip, or near the bottom of the list, scrolls it into view with its details.
  $effect(() => {
    const index = inspector.selectedWalEntry;
    if (index === null || !list) return;
    if (index >= listed.length) showAll = true;
    requestAnimationFrame(() => {
      const row = list?.querySelector<HTMLElement>(".row.open");
      if (list && row) list.scrollTop = row.offsetTop - 28;
    });
  });

  async function onchange(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    error = "";
    const bytes = new Uint8Array(await file.slice(0, MAX_WAL_BYTES).arrayBuffer());
    const parsed = walFor({ name: file.name, bytes, size: file.size }, inspector.model);
    if (parsed.entries[0]?.type === -1) error = `${file.name} doesn't look like a DuckDB write-ahead log.`;
    inspector.selectedWalEntry = null;
    inspector.wal = parsed;
  }

  function label(e: WalEntry): string {
    return e.typeName === "WAL_FLUSH" ? "COMMIT" : e.typeName.replaceAll("_", " ");
  }

  /** Strip widths: proportional to bytes, but never so thin that small entries can't be clicked. */
  function grow(e: WalEntry): number {
    const total = wal?.read || 1;
    return Math.max((e.end - e.start) / total, 0.004);
  }
</script>

<section class="card" aria-label="Write-ahead log">
  <div class="head">
    <h2>
      Write-ahead log
      <small>
        {#if wal}
          <span class="mono">{wal.name}</span> · {formatBytes(wal.size)} · {formatNumber(changes)} changes in {formatNumber(
            wal.commits,
          )} commits
          {#if incomplete}· <span class="warn">{formatNumber(incomplete)} incomplete</span>{/if}
        {:else}
          changes not yet checkpointed into the blocks above
        {/if}
      </small>
    </h2>
    <label class="pick">
      {wal ? "Open another .wal" : "Open .wal"}
      <input type="file" accept=".wal" hidden {onchange} />
    </label>
  </div>

  {#if error}<p class="note error">{error}</p>{/if}

  {#if !wal}
    <p class="empty">
      {inspector.walSearched
        ? "No .wal next to this database: every committed change is already in its blocks."
        : "A file picked in the browser can't see the .wal next to it. Open it here, or pick both files together."}
    </p>
  {:else}
    <p class="note">
      DuckDB appends every committed change here and replays the log when it next opens the database, until a checkpoint
      moves the changes into blocks. Click an entry to see what it holds.
    </p>
    {#each wal.notes as note (note)}<p class="note warn">{note}</p>{/each}

    {#if entries.length}
      <div class="strip" role="group" aria-label="WAL entries by size">
        {#each entries as e (e.index)}
          <button
            type="button"
            class="cell {e.category}"
            class:incomplete={isIncomplete(e)}
            class:selected={inspector.selectedWalEntry === e.index}
            style:flex-grow={grow(e)}
            title="#{e.index} {e.summary}{isIncomplete(e) ? ' (incomplete)' : ''}"
            aria-label="Entry {e.index}: {e.summary}"
            onclick={() => inspector.toggleWalEntry(e.index)}
          ></button>
        {/each}
      </div>
      <div class="key">
        <span><i class="catalog"></i>catalog</span>
        <span><i class="data"></i>data</span>
        <span><i class="meta"></i>table switch, sequence, header</span>
        <span><i class="commit"></i>commit</span>
        <span><i class="incomplete"></i>incomplete</span>
      </div>
    {/if}

    <div class="list" bind:this={list}>
      <div class="row header">
        <span>#</span><span>offset</span><span>entry</span><span></span><span class="r">size</span>
      </div>
      {#each listed as e (e.index)}
        {@const bad = isIncomplete(e)}
        <button
          type="button"
          class="row"
          class:incomplete={bad}
          class:commit={e.category === "commit"}
          class:open={inspector.selectedWalEntry === e.index}
          aria-expanded={inspector.selectedWalEntry === e.index}
          onclick={() => inspector.toggleWalEntry(e.index)}
        >
          <span class="muted mono">{e.index}</span>
          <span class="muted mono">{formatNumber(e.start)}</span>
          <span class="what">
            <span class="type {e.category}">{label(e)}</span>
            <span class="summary">{e.category === "commit" ? `transaction #${e.txn}` : e.summary}</span>
          </span>
          <span
            >{#if bad}<span class="tag">incomplete</span>{/if}</span
          >
          <span class="r mono">{formatBytes(e.end - e.start)}</span>
        </button>
        {#if inspector.selectedWalEntry === e.index}
          <WalEntryDetail {wal} entry={e} />
        {/if}
      {/each}
      {#if listed.length < entries.length}
        <button type="button" class="more" onclick={() => (showAll = true)}>
          Show all {formatNumber(entries.length)} entries
        </button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .card {
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px 12px;
  }

  h2 small {
    font-size: 12px;
  }

  .warn {
    color: var(--text-2);
    font-weight: 500;
  }

  .pick {
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
  }

  .pick:hover {
    border-color: #d1d5db;
  }

  .note,
  .empty {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--text-3);
  }

  .note.warn {
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
  }

  .note.error {
    color: var(--error);
  }

  .empty {
    margin: 4px 0 0;
  }

  .strip {
    display: flex;
    gap: 1px;
    height: 22px;
    margin-bottom: 6px;
  }

  .cell {
    min-width: 3px;
    padding: 0;
    border: 0;
    border-radius: 2px;
    cursor: pointer;
  }

  .cell.selected {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .catalog {
    background: #c4b5fd;
  }

  .data {
    background: #93c5fd;
  }

  .meta {
    background: #e5e7eb;
  }

  .commit {
    background: #4b5563;
  }

  .incomplete {
    background: repeating-linear-gradient(135deg, #d1d5db 0 3px, #eceef1 3px 6px) !important;
  }

  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-bottom: 10px;
    font-size: 11.5px;
    color: var(--text-4);
  }

  .key span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .key i {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }

  .list {
    position: relative;
    max-height: 560px;
    overflow: hidden auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    font-size: 12px;
    scrollbar-gutter: stable;
  }

  .row {
    display: grid;
    grid-template-columns: 36px 80px minmax(0, 1fr) 80px 64px;
    gap: 10px;
    align-items: center;
    width: 100%;
    min-height: 28px;
    padding: 0 12px;
    border: 0;
    border-bottom: 1px solid var(--line-soft);
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--surface-2);
  }

  .row.open {
    background: var(--accent-soft);
  }

  .row.header {
    position: sticky;
    top: 0;
    z-index: 1;
    min-height: 26px;
    background: var(--surface);
    font-size: 11px;
    color: var(--text-4);
    cursor: default;
  }

  .row.commit {
    min-height: 20px;
    font-size: 11px;
    color: var(--text-4);
  }

  .row.incomplete,
  .row.incomplete .summary {
    color: var(--text-4);
  }

  .row.incomplete {
    background: repeating-linear-gradient(135deg, transparent 0 6px, #f6f7f9 6px 12px);
  }

  .what {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .type {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #1f2937;
  }

  .type.commit {
    color: #fff;
  }

  .type.meta {
    color: var(--text-3);
  }

  .row.incomplete .type {
    background: #e5e7eb;
    color: var(--text-4);
  }

  .summary {
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    padding: 1px 6px;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    font-size: 10.5px;
    color: var(--text-3);
  }

  .r {
    text-align: right;
  }

  .more {
    width: 100%;
    padding: 6px;
    border: 0;
    background: none;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }

  @media (max-width: 700px) {
    .card {
      padding: 12px;
    }
    .row {
      grid-template-columns: 26px minmax(0, 1fr) auto 52px;
      gap: 8px;
      padding: 4px 10px;
    }
    .row > :nth-child(2) {
      display: none;
    }
  }
</style>
