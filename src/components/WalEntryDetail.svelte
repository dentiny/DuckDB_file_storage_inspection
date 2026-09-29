<script lang="ts">
  import { formatBytes, formatNumber } from "../lib/format";
  import { decodeEntry, isIncomplete, type WalEntry, type WalFile } from "../lib/duckdb/wal";

  /** Bytes of the raw entry shown in the hex dump. */
  const HEX_BYTES = 512;

  let { wal, entry, onclose }: { wal: WalFile; entry: WalEntry; onclose: () => void } = $props();

  const detail = $derived(decodeEntry(wal, entry));
  const incomplete = $derived(isIncomplete(entry));
  const facts = $derived<[string, string][]>([
    ["Bytes", `${formatNumber(entry.start)} – ${formatNumber(entry.end)}`],
    ["Size", formatBytes(entry.end - entry.start)],
    ...(entry.typeName === "WAL_VERSION" ? [] : ([["Transaction", `#${entry.txn}`]] as [string, string][])),
    ...detail.fields,
  ]);
  const hex = $derived.by(() => {
    const end = Math.min(entry.end, entry.start + HEX_BYTES);
    const lines: { offset: number; hex: string; text: string }[] = [];
    for (let at = entry.start; at < end; at += 16) {
      const row = wal.bytes.subarray(at, Math.min(at + 16, end));
      lines.push({
        offset: at,
        hex: [...row].map((b) => b.toString(16).padStart(2, "0")).join(" "),
        text: [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join(""),
      });
    }
    return lines;
  });
</script>

<div class="detail" class:incomplete>
  {#if incomplete}
    <div class="problems">
      <b>Incomplete</b>
      <ul>
        {#each entry.problems as problem (problem)}<li>{problem}</li>{/each}
      </ul>
    </div>
  {/if}

  <dl>
    {#each facts as [label, value] (label)}
      <dt>{label}</dt>
      <dd class="mono">{value}</dd>
    {/each}
  </dl>

  {#if detail.sql}
    <pre class="sql mono">{detail.sql}</pre>
  {/if}

  {#if detail.chunk}
    {@const chunk = detail.chunk}
    <div class="grid-caption">
      {!chunk.cells.length
        ? `${formatNumber(chunk.rows)} row${chunk.rows === 1 ? "" : "s"}, but their values are cut off`
        : chunk.cells.length < chunk.rows
          ? `First ${formatNumber(chunk.cells.length)} of ${formatNumber(chunk.rows)} rows`
          : `${formatNumber(chunk.rows)} row${chunk.rows === 1 ? "" : "s"}`}
    </div>
    <div class="grid">
      <table class="mono">
        <thead>
          <tr>
            {#each chunk.columns as column, i (i)}
              <th><span>{column.name}</span><small>{column.type}</small></th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each chunk.cells as row, r (r)}
            <tr>
              {#each row as cell, c (c)}
                <td class:null={cell === null} title={cell ?? "NULL"}>{cell ?? "NULL"}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if detail.stopped}
    <p class="stopped">{detail.stopped}</p>
  {/if}

  <details>
    <summary>Raw bytes{entry.end - entry.start > HEX_BYTES ? ` · first ${HEX_BYTES}` : ""}</summary>
    <div class="hex mono">
      {#each hex as line (line.offset)}
        <span class="off">{line.offset.toString(16).padStart(8, "0")}</span>
        <span>{line.hex}</span>
        <span class="text">{line.text}</span>
      {/each}
    </div>
  </details>

  <button type="button" class="close" onclick={onclose}>Close</button>
</div>

<style>
  .detail {
    position: relative;
    margin: 2px 0 8px 36px;
    padding: 10px 12px;
    border-radius: var(--radius);
    outline: 1px solid #e0e7ff;
    background: var(--surface);
  }

  .detail.incomplete {
    outline-color: var(--line);
    background: var(--surface-2);
  }

  .problems {
    margin-bottom: 10px;
    padding: 8px 10px;
    border-left: 3px solid var(--text-4);
    border-radius: var(--radius-sm);
    background: #f3f4f6;
    color: var(--text-2);
  }

  .problems ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }

  dl {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 3px 10px;
    margin: 0 60px 8px 0;
    font-size: 12px;
  }

  dt {
    color: var(--text-4);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .sql {
    margin: 0 0 8px;
    padding: 8px 10px;
    overflow-x: auto;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 12px;
    white-space: pre;
  }

  .grid-caption {
    margin-bottom: 4px;
    font-size: 11.5px;
    color: var(--text-4);
  }

  .grid {
    max-height: 320px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  table {
    border-collapse: collapse;
    font-size: 11.5px;
  }

  th,
  td {
    max-width: 260px;
    padding: 3px 8px;
    overflow: hidden;
    border-bottom: 1px solid var(--line-soft);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--surface);
    font-weight: 600;
  }

  th small {
    display: block;
    font-weight: 400;
    color: #7c3aed;
  }

  td.null {
    font-style: italic;
    color: var(--text-4);
  }

  .stopped {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--text-3);
  }

  details {
    margin-top: 8px;
    font-size: 12px;
  }

  summary {
    color: var(--text-3);
    cursor: pointer;
  }

  .hex {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 0 14px;
    margin-top: 6px;
    overflow-x: auto;
    font-size: 11px;
    white-space: pre;
  }

  .off,
  .text {
    color: var(--text-4);
  }

  .close {
    position: absolute;
    top: 8px;
    right: 10px;
    padding: 2px 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 11.5px;
    color: var(--text-3);
    cursor: pointer;
  }

  @media (max-width: 700px) {
    .detail {
      margin-left: 0;
    }
    dl {
      grid-template-columns: 84px minmax(0, 1fr);
    }
  }
</style>
