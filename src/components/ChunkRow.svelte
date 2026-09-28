<script lang="ts">
  import ColumnName from "./ColumnName.svelte";
  import { pieceColor } from "../lib/colors";
  import { formatBytes, formatNumber, formatValue } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import { leafAt, type Chunk } from "../lib/duckdb/model";

  let { chunk, maxChunk }: { chunk: Chunk; maxChunk: number } = $props();

  const inspector = getInspector();
  const column = $derived(leafAt(inspector.model.leaves, chunk.leaf));
  const stored = $derived(chunk.segments.filter((s) => s.piece).length);
  const info = $derived(
    [
      `${formatNumber(stored)} segment${stored === 1 ? "" : "s"}`,
      chunk.segments.length > stored ? `${formatNumber(chunk.segments.length - stored)} constant` : null,
      chunk.compressions.join(", "),
      chunk.hasNull ? "nulls" : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<div class="row" class:selected={inspector.selectedLeaf === chunk.leaf}>
  <span class="name mono"><ColumnName name={column.name} /></span>
  <div class="pages" style:width="{Math.max(6, (chunk.bytes / maxChunk) * 100)}%">
    {#each chunk.parts as part (part.start)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        style:flex="{part.end - part.start} 0 0"
        style:background={pieceColor(part, inspector.selectedLeaf)}
        onpointermove={(event) => event.pointerType === "mouse" && inspector.showPopover(part, event)}
        onpointerleave={() => inspector.hidePopover()}
        onclick={(event) => {
          event.stopPropagation();
          inspector.showPopover(part, event);
        }}
      ></div>
    {/each}
  </div>
  <span class="size mono">{chunk.bytes ? formatBytes(chunk.bytes) : "0 B"}</span>
  <div class="detail">
    <span class="minmax mono">
      {chunk.bounds
        ? `${formatValue(chunk.bounds.min, column.type)} … ${formatValue(chunk.bounds.max, column.type)}`
        : "no min/max"}
    </span>
    <span class="info">{info}</span>
  </div>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr) 64px;
    grid-template-areas: "name pages size" "name detail detail";
    gap: 2px 12px;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid #f3f4f6;
  }

  .row:last-child {
    border: 0;
  }

  .selected {
    background: var(--accent-soft);
  }

  .row > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    display: flex;
    grid-area: name;
    align-self: start;
    min-width: 0;
  }

  .pages {
    grid-area: pages;
    display: flex;
    gap: 1px;
    height: 10px;
  }

  .pages > div {
    min-width: 2px;
    height: 100%;
    border-radius: 1px;
  }

  .pages > div:hover {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--text);
  }

  .size {
    grid-area: size;
    text-align: right;
  }

  .detail {
    display: flex;
    grid-area: detail;
    gap: 12px;
    min-width: 0;
    font-size: 11px;
  }

  .minmax {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: #4b5563;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .info {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-4);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "name size" "pages pages" "detail detail";
    }
    .pages {
      height: 14px;
    }
  }
</style>
