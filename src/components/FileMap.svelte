<script lang="ts">
  import ByteStrip from "./ByteStrip.svelte";
  import Legend from "./Legend.svelte";
  import { formatBytes, formatNumber } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import { BLOCKS_START, blockStart } from "../lib/duckdb/header";
  import type { RowGroupInfo } from "../lib/duckdb/model";
  import { rowGroupOf } from "../lib/popover";

  const inspector = getInspector();
  const { model } = inspector;
  const { header } = model;

  const body = model.pieces.filter((p) => p.start >= BLOCKS_START);
  const head = model.pieces.filter((p) => p.start < BLOCKS_START);
  const seams = Array.from({ length: header.blockCount + 1 }, (_, b) => blockStart(header, b));
  const partsOf = (g: RowGroupInfo | null) => g?.chunks.flatMap((c) => c.parts) ?? [];
  const selected = $derived(partsOf(inspector.selectedGroup));
  const highlighted = $derived(partsOf(inspector.hoveredRg));
  const tables = model.tables.length;
</script>

<section class="card">
  <div class="strips">
    <div>
      <div class="caption">
        <span>
          <b>Blocks</b> · {formatNumber(header.blockCount)} × {formatBytes(header.blockAllocSize)}
          <span class="on-hover">· click a segment to open its row group</span>
        </span>
        <span>{formatBytes(model.fileSize - BLOCKS_START)}</span>
      </div>
      <ByteStrip
        pieces={body}
        from={BLOCKS_START}
        to={Math.max(model.fileSize, BLOCKS_START + 1)}
        label="File layout"
        {seams}
        {selected}
        {highlighted}
        onpick={(piece) => {
          const at = rowGroupOf(piece);
          if (at) inspector.toggleRowGroup(at.table, at.rg, { reveal: true });
        }}
      />
    </div>
    <div>
      <div class="caption">
        <span><b>Headers</b> magnified</span>
        <span>{formatBytes(BLOCKS_START)}</span>
      </div>
      <ByteStrip pieces={head} from={0} to={BLOCKS_START} label="Headers" />
    </div>
  </div>
  <Legend />
  <p class="hint">
    <span class="on-hover">
      Hover a segment or block for details. {tables > 1 ? `Colors are columns across all ${tables} tables.` : ""}
    </span>
    <span class="on-touch">Tap a segment to open its row group below.</span>
  </p>
</section>

<style>
  .card {
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .strips {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 180px;
    gap: 16px;
  }

  .caption {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 11px;
    color: var(--text-4);
  }

  .caption b {
    font-weight: 500;
    color: var(--text-2);
  }

  .hint {
    margin: 6px 0 0;
    font-size: 11.5px;
    color: var(--text-4);
  }

  @media (max-width: 700px) {
    .card {
      padding: 12px;
    }
    .strips {
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
    }
  }
</style>
