<script lang="ts">
  import { formatBytes, formatNumber } from "../lib/format";
  import { getInspector } from "../lib/inspector.svelte";
  import { KINDS } from "../lib/kinds";
  import {
    HEADER_SIZE,
    metadataSubBlockSize,
    subBlockStart,
    type Chain,
    type DatabaseHeader,
    type MetaPointer,
  } from "../lib/duckdb/header";
  import { blockStates, type BlockInfo, type BlockState } from "../lib/duckdb/model";

  const inspector = getInspector();
  const { model } = inspector;
  const { file } = model;
  const blocks = blockStates(model);

  const STATES: { state: BlockState; label: string; color: string }[] = [
    { state: "data", label: "table data", color: "#93c5fd" },
    { state: "metadata", label: "metadata", color: KINDS.metadata.color },
    { state: "free", label: "free", color: KINDS.free.color },
    { state: "unknown", label: "other (e.g. index)", color: KINDS.unknown.color },
    { state: "unread", label: "unread", color: KINDS.unread.color },
    { state: "missing", label: "missing", color: KINDS.missing.color },
  ];
  const colorOf = Object.fromEntries(STATES.map((s) => [s.state, s.color])) as Record<BlockState, string>;
  const counts = STATES.map((s) => ({ ...s, count: blocks.filter((b) => b.state === s.state).length })).filter(
    (s) => s.count > 0,
  );
  const shared = blocks.filter((b) => b.segments > 1);
  const freeRanges = ranges(model.blocks.free);

  function ranges(ids: number[]): string[] {
    const sorted = [...ids].sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++;
      out.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
      i = j + 1;
    }
    return out;
  }

  const pointer = (p: MetaPointer) => `block ${p.block} · sub-block ${p.index}`;
  const spansOf = (h: DatabaseHeader, chain: Chain) =>
    chain.hops.map((hop) => {
      const start = subBlockStart(h, hop);
      return { start, end: start + metadataSubBlockSize(h) };
    });

  /** Whether the active version's metadata lists this sub-block as free, i.e. an older version's metadata was there. */
  const freeNow = (p: MetaPointer) =>
    model.pieces.some((x) => x.kind === "metadataFree" && x.block === p.block && x.from <= p.index && p.index <= x.to);

  function hoverChain(h: DatabaseHeader, chain: Chain | null) {
    inspector.highlight = chain ? spansOf(h, chain) : null;
  }

  function hoverBlock(b: BlockInfo | null) {
    inspector.highlight = b ? [{ start: b.start, end: b.end }] : null;
  }

  function describe(b: BlockInfo): string {
    const label = STATES.find((s) => s.state === b.state)?.label ?? b.state;
    return `Block ${b.block}: ${label}${b.segments > 1 ? `, shared by ${b.segments} segments` : ""}`;
  }
</script>

<section class="card" aria-label="Block allocation">
  <h2>Block allocation <small>where the headers point, and what each block is used for</small></h2>

  <div class="headers">
    {#each file.headers as h, slot (slot)}
      {@const active = slot === file.active}
      {@const chains = model.chains[slot]}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="header"
        class:active
        onpointerenter={() => (inspector.highlight = [{ start: h.offset, end: h.offset + HEADER_SIZE }])}
        onpointerleave={() => (inspector.highlight = null)}
      >
        <div class="title">
          <b>Database header {slot + 1}</b>
          <span class="badge" class:on={active}>{active ? "active" : "previous checkpoint"}</span>
          <span class="check" class:bad={!h.checksumOk}>{h.checksumOk ? "checksum ✓" : "checksum ✗"}</span>
        </div>
        <dl>
          <dt>Checkpoint</dt>
          <dd class="mono">{formatNumber(h.iteration)}</dd>
          <dt>Blocks</dt>
          <dd class="mono">{formatNumber(h.blockCount)} × {formatBytes(h.blockAllocSize)}</dd>
          {#each [["Catalog root", h.metaBlock, chains?.catalog ?? null], ["Free list", h.freeList, chains?.freeList ?? null]] as const as [label, target, chain] (label)}
            <dt>{label}</dt>
            <dd>
              {#if target}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span
                  class="pointer mono"
                  onpointerenter={(event) => {
                    event.stopPropagation();
                    hoverChain(h, chain);
                  }}
                  onpointerleave={() => (inspector.highlight = [{ start: h.offset, end: h.offset + HEADER_SIZE }])}
                  >→ {pointer(target)}</span
                >
                {#if chain}
                  <span class="chain mono">
                    {chain.hops.length === 0
                      ? ""
                      : chain.hops.length === 1
                        ? "1 sub-block"
                        : `${formatNumber(chain.hops.length)} sub-blocks: ${chain.hops
                            .slice(0, 6)
                            .map((p) => `${p.block}.${p.index}`)
                            .join(" → ")}${chain.hops.length > 6 ? " → …" : ""}`}
                    {#if chain.error}<span class="warn">{chain.hops.length ? "· " : ""}{chain.error}</span>{/if}
                    {#if !active && chain.hops.length && chain.hops.every(freeNow)}
                      <span class="stale">· free again in the active checkpoint</span>
                    {/if}
                  </span>
                {/if}
              {:else}
                <span class="muted">none</span>
              {/if}
            </dd>
          {/each}
        </dl>
      </div>
    {/each}
  </div>

  <div class="grid" role="group" aria-label="Blocks by state">
    {#each blocks as b (b.block)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="cell"
        class:shared={b.segments > 1}
        class:dense={blocks.length > 600}
        style:background={colorOf[b.state]}
        title={describe(b)}
        onpointerenter={() => hoverBlock(b)}
        onpointerleave={() => hoverBlock(null)}
      ></span>
    {/each}
  </div>
  <div class="key">
    {#each counts as s (s.state)}
      <span><i style:background={s.color}></i>{s.label} <b>{formatNumber(s.count)}</b></span>
    {/each}
    {#if shared.length}<span><i class="dot"></i>shared by several segments <b>{formatNumber(shared.length)}</b></span
      >{/if}
  </div>

  <dl class="lists">
    <dt>Free list</dt>
    <dd class="mono">
      {#if model.usage === null}
        <span class="muted">couldn't be read</span>
      {:else if freeRanges.length}
        {freeRanges.join(", ")}
        <span class="muted">({formatNumber(model.blocks.free.length)} blocks, reused before the file grows)</span>
      {:else}
        <span class="muted">empty: no free blocks</span>
      {/if}
    </dd>
    {#if shared.length}
      <dt>Shared blocks</dt>
      <dd class="mono">
        {#each shared.slice(0, 40) as b (b.block)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="chip" onpointerenter={() => hoverBlock(b)} onpointerleave={() => hoverBlock(null)}
            >{b.block} <span class="muted">×{b.segments}</span></span
          >
        {/each}
        {#if shared.length > 40}<span class="muted">+{formatNumber(shared.length - 40)} more</span>{/if}
      </dd>
    {/if}
    {#if model.blocks.metadata.length}
      <dt>Metadata blocks</dt>
      <dd class="mono">{model.blocks.metadata.join(", ")}</dd>
    {/if}
  </dl>
</section>

<style>
  .card {
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .headers {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }

  .header {
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface-2);
  }

  .header.active {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin-bottom: 6px;
  }

  .badge {
    padding: 1px 7px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 11px;
    color: var(--text-3);
  }

  .badge.on {
    border-color: var(--accent-line);
    background: var(--surface);
    color: var(--accent);
  }

  .check {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--ok);
  }

  .check.bad,
  .warn {
    color: var(--error);
  }

  dl {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 3px 10px;
    margin: 0;
    font-size: 12px;
  }

  dt {
    color: var(--text-4);
  }

  dd {
    margin: 0;
    min-width: 0;
  }

  .pointer {
    border-bottom: 1px dashed var(--text-4);
    cursor: default;
  }

  .pointer:hover {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }

  .chain {
    display: block;
    font-size: 11px;
    color: var(--text-3);
  }

  .stale {
    color: var(--text-4);
  }

  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-bottom: 6px;
  }

  .cell {
    position: relative;
    width: 14px;
    height: 14px;
    border-radius: 2px;
  }

  .cell.dense {
    width: 7px;
    height: 7px;
  }

  .cell:hover {
    outline: 2px solid var(--text);
  }

  .cell.shared::after,
  .dot {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #1f2937;
    transform: translate(-50%, -50%);
  }

  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-bottom: 10px;
    font-size: 11.5px;
    color: var(--text-3);
  }

  .key span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .key i {
    position: relative;
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }

  .key i.dot {
    position: static;
    transform: none;
  }

  .key b {
    font-weight: 600;
    color: var(--text-2);
  }

  .lists {
    grid-template-columns: 110px minmax(0, 1fr);
  }

  .chip {
    display: inline-block;
    margin: 0 4px 3px 0;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 11px;
  }

  .chip:hover {
    border-color: var(--text-3);
  }

  @media (max-width: 700px) {
    .card {
      padding: 12px;
    }
    .headers {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
