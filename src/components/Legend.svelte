<script lang="ts">
  import ColumnName from "./ColumnName.svelte";
  import { leafColor } from "../lib/colors";
  import { formatNumber } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import { KINDS } from "../lib/kinds";
  import type { PieceKind } from "../lib/duckdb/model";

  const MAX_COLUMNS = 12;

  const inspector = getInspector();
  const { model } = inspector;
  const shown = model.leaves.map((leaf, i) => ({ leaf, i })).slice(0, MAX_COLUMNS);
  const hidden = model.leaves.length - shown.length;
  const present = new Set(model.pieces.map((p) => p.kind));
  const keys = (
    ["validity", "overflow", "slack", "metadata", "free", "unknown", "unread", "missing"] as PieceKind[]
  ).filter((k) => present.has(k));
</script>

<div class="legend">
  {#each shown as { leaf, i } (leaf.path)}
    <span class="item" class:dim={inspector.selectedLeaf !== null && inspector.selectedLeaf !== i}>
      <span class="swatch" style:background={leafColor(i, null)}></span>
      <span class="mono path"><ColumnName name={leaf.path} /></span>
    </span>
  {/each}
  {#if hidden > 0}
    <span class="muted">+{formatNumber(hidden)} more</span>
  {/if}
  <span class="key">
    {#each keys as kind (kind)}
      <span class="item">
        <span
          class="swatch"
          class:light={kind === "validity" || kind === "overflow"}
          style:background={KINDS[kind].color}
        ></span>
        {KINDS[kind].label.toLowerCase()}
      </span>
    {/each}
  </span>
</div>

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 14px;
    margin-top: 10px;
    font-size: 11.5px;
    color: #4b5563;
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    min-width: 0;
  }

  .path {
    display: flex;
    min-width: 0;
  }

  .dim {
    opacity: 0.4;
  }

  .key {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px 13px;
    margin-left: auto;
    color: var(--text-4);
  }

  .light {
    background: var(--line) !important;
  }

  @media (max-width: 700px) {
    .key {
      margin-left: 0;
    }
  }
</style>
