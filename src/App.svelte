<script lang="ts">
  import EmptyState from "./components/EmptyState.svelte";
  import SourceInput from "./components/SourceInput.svelte";
  import Viewer from "./components/Viewer.svelte";
  import WalPanel from "./components/WalPanel.svelte";
  import { Inspector, type Initial } from "./lib/inspector.svelte";
  import { describeError, loadDuckDB, loadWal } from "./lib/duckdb/load";
  import {
    fetchWal,
    fileSource,
    nameOf,
    resolveInput,
    urlSource,
    type Source,
    walFromFile,
    type WalBytes,
  } from "./lib/duckdb/source";
  import { browserEngine } from "./lib/duckdb/wasm";
  import { fromQuery, publishQuery, toQuery } from "./lib/share";
  import { WalView } from "./lib/walview.svelte";

  let input = $state("");
  let status = $state<{ text: string; error?: boolean } | null>(null);
  let inspector = $state.raw<Inspector | null>(null);
  /** A write-ahead log opened without its database. */
  let walOnly = $state.raw<WalView | null>(null);
  let dragging = $state(false);
  /** Ignores results from a load that a newer one replaced. */
  let loadId = 0;

  /** Clears the page, runs `task`, and reports its error unless a newer load replaced it meanwhile. */
  async function run(name: string, task: (current: () => boolean) => Promise<void>) {
    const id = ++loadId;
    const current = () => id === loadId;
    status = { text: `Reading ${name}…` };
    inspector = null;
    walOnly = null;
    try {
      await task(current);
      if (current()) status = null;
    } catch (error) {
      if (!current()) return;
      console.error(error);
      status = { text: `Couldn't read ${name}: ${describeError(error)}`, error: true };
    }
  }

  function load(name: string, open: () => Promise<Source>, source: string | null, initial?: Initial) {
    return run(name, async (current) => {
      const started = performance.now();
      const [file, engine] = await Promise.all([open(), browserEngine()]);
      const model = await loadDuckDB(file, engine);
      const wal = await loadWal(file, model).catch((error: unknown) => {
        console.warn("couldn't read the write-ahead log", error);
        return null;
      });
      if (!current()) return;
      const summary = `read by DuckDB-Wasm ${engine.version} · ${Math.round(performance.now() - started)} ms`;
      const searched = file.origin.kind !== "file" || file.walSize !== null;
      inspector = new Inspector(model, source, initial ?? { table: null, rg: null, col: null }, summary, wal, searched);
    });
  }

  /** Shows a write-ahead log on its own, for when its database is missing or wasn't picked. */
  function loadWalOnly(name: string, read: () => Promise<WalBytes | null>, source: string | null) {
    return run(name, async (current) => {
      const wal = await read();
      if (!wal) throw new Error("there's no write-ahead log there");
      if (!current()) return;
      walOnly = new WalView(null, true, null);
      walOnly.load(wal);
      if (source !== null) publishQuery(toQuery({ db: source, table: null, rg: null, col: null }));
    });
  }

  function openInput(raw: string, initial?: Initial) {
    input = raw;
    const name = nameOf(raw);
    const url = resolveInput(raw, location.href);
    if (name.endsWith(".wal")) void loadWalOnly(name, () => fetchWal(url, name), raw);
    else void load(name, () => urlSource(url, name), raw, initial);
  }

  /** Opens a database, paired with its `.wal` when both were picked or dropped together; or a `.wal` alone. */
  function openFiles(files: File[]) {
    const database = files.find((f) => !f.name.endsWith(".wal"));
    const wal = files.find((f) => f.name === `${database?.name}.wal`) ?? files.find((f) => f.name.endsWith(".wal"));
    input = (database ?? wal)?.name ?? "";
    if (database) void load(database.name, () => fileSource(database, wal), null);
    else if (wal) void loadWalOnly(wal.name, () => walFromFile(wal), null);
  }

  function ondrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) openFiles(files);
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

  <SourceInput bind:value={input} onsubmit={(value) => openInput(value)} onfiles={openFiles} />

  <p class="status" class:error={status?.error} role="status">{status?.text ?? ""}</p>

  {#if inspector}
    {#key inspector}
      <Viewer {inspector} />
    {/key}
  {:else if walOnly}
    {#key walOnly}
      <div class="wal-only"><WalPanel view={walOnly} /></div>
    {/key}
  {:else if !status?.text}
    <EmptyState />
  {/if}
</div>

{#if dragging}
  <div class="drop">Drop a .duckdb file, and its .wal if it has one</div>
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

  .wal-only {
    margin-top: 18px;
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
