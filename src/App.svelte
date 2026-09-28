<script lang="ts">
  import EmptyState from "./components/EmptyState.svelte";
  import SourceInput from "./components/SourceInput.svelte";
  import Viewer from "./components/Viewer.svelte";
  import { Inspector, type Initial } from "./lib/inspector.svelte";
  import { describeError, loadDuckDB } from "./lib/duckdb/load";
  import { fileSource, nameOf, resolveInput, urlSource, type Source } from "./lib/duckdb/source";
  import { browserEngine } from "./lib/duckdb/wasm";
  import { fromQuery } from "./lib/share";

  let input = $state("");
  let status = $state<{ text: string; error?: boolean } | null>(null);
  let inspector = $state.raw<Inspector | null>(null);
  let dragging = $state(false);
  /** Ignores results from a load that a newer one replaced. */
  let loadId = 0;

  async function load(
    name: string,
    open: () => Promise<Source>,
    source: string | null,
    initial: Initial = { table: null, rg: null, col: null },
  ) {
    const id = ++loadId;
    status = { text: `Reading ${name}…` };
    inspector = null;
    const started = performance.now();
    try {
      const [file, engine] = await Promise.all([open(), browserEngine()]);
      if (id !== loadId) return;
      const model = await loadDuckDB(file, engine);
      if (id !== loadId) return;
      const ms = Math.round(performance.now() - started);
      inspector = new Inspector(model, source, initial, `read by DuckDB-Wasm ${engine.version} · ${ms} ms`);
      status = null;
    } catch (error) {
      if (id !== loadId) return;
      console.error(error);
      status = { text: `Couldn't read ${name}: ${describeError(error)}`, error: true };
    }
  }

  function openInput(raw: string, initial?: Initial) {
    input = raw;
    const name = nameOf(raw);
    void load(name, () => urlSource(resolveInput(raw, location.href), name), raw, initial);
  }

  function openFile(file: File) {
    input = file.name;
    void load(file.name, () => fileSource(file), null);
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const file = event.dataTransfer?.files[0];
    if (file) openFile(file);
  }

  const initial = fromQuery(location.search);
  if (initial) openInput(initial.db, initial);
</script>

<svelte:window
  ondragover={(event) => {
    event.preventDefault();
    dragging = true;
  }}
  ondragleave={(event) => {
    if (!event.relatedTarget) dragging = false;
  }}
  {ondrop}
/>

<div class="page">
  <header>
    <h1><span class="logo" aria-hidden="true">▦</span> DuckDB File Storage Inspection</h1>
    <p>
      See how a DuckDB database file is laid out, block by block: headers, metadata, row groups and column segments.
    </p>
  </header>

  <SourceInput bind:value={input} onsubmit={(value) => openInput(value)} onfile={openFile} />

  <p class="status" class:error={status?.error} role="status">{status?.text ?? ""}</p>

  {#if inspector}
    {#key inspector}
      <Viewer {inspector} />
    {/key}
  {:else if !status?.text}
    <EmptyState />
  {/if}
</div>

{#if dragging}
  <div class="drop">Drop a .duckdb file anywhere</div>
{/if}

<style>
  .page {
    max-width: 1280px;
    margin: 0 auto;
    padding: 28px 28px 60px;
  }

  header {
    margin-bottom: 16px;
  }

  h1 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 20px;
  }

  .logo {
    color: #d97706;
  }

  header p {
    margin: 4px 0 0;
    color: var(--text-3);
  }

  .status {
    min-height: 18px;
    margin: 18px 0 0;
    font-size: 12px;
    color: var(--text-3);
  }

  .status:empty {
    min-height: 0;
    margin: 0;
  }

  .status.error {
    color: var(--error);
  }

  .drop {
    position: fixed;
    inset: 12px;
    z-index: 20;
    display: grid;
    place-items: center;
    border: 2px dashed #818cf8;
    border-radius: 16px;
    background: rgb(238 242 255 / 85%);
    font-size: 18px;
    color: #4338ca;
    pointer-events: none;
  }

  @media (max-width: 700px) {
    .page {
      padding: 18px 14px 40px;
    }
    h1 {
      font-size: 18px;
    }
    header p {
      font-size: 12.5px;
    }
  }
</style>
