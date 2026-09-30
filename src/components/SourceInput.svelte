<script lang="ts">
  import { pickLocalPath } from "../lib/duckdb/source";

  interface Props {
    value: string;
    onsubmit: (value: string) => void;
    onfiles: (files: File[]) => void;
  }

  let { value = $bindable(), onsubmit, onfiles }: Props = $props();

  const examples = [
    { label: "sensors (sorted, nested types, long strings, free blocks)", value: "sensors.duckdb" },
    { label: "orders (write-ahead log with a torn last commit)", value: "orders.duckdb" },
  ];

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (value.trim()) onsubmit(value);
  }

  function onchange(event: Event & { currentTarget: HTMLInputElement }) {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (files.length) onfiles(files);
  }

  let picker: HTMLInputElement;
  let choosing = $state(false);

  /** Opens the system's dialog through the local server, so the path is known; the browser's picker otherwise. */
  async function choose() {
    choosing = true;
    try {
      const path = await pickLocalPath();
      if (path === undefined) picker.click();
      else if (path !== null) onsubmit(path);
    } finally {
      choosing = false;
    }
  }
</script>

<form onsubmit={submit}>
  <input
    bind:value
    type="text"
    spellcheck="false"
    autocomplete="off"
    aria-label="DuckDB database path"
    placeholder="A path on this machine, like ~/data/app.duckdb"
  />
  <button type="submit" class="primary">Inspect</button>
  <button type="button" class="secondary" disabled={choosing} onclick={choose}>Open file</button>
  <input bind:this={picker} type="file" accept=".duckdb,.db,.ddb,.wal" multiple hidden {onchange} />
</form>

<div class="examples">
  <span class="muted">Try</span>
  {#each examples as example (example.value)}
    <button type="button" onclick={() => onsubmit(example.value)}>{example.label}</button>
  {/each}
</div>

<style>
  form {
    display: flex;
    gap: 8px;
  }

  input[type="text"] {
    flex: 1;
    padding: 9px 12px;
    border: 1px solid #d1d5db;
    border-radius: var(--radius);
    outline: none;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  input[type="text"]:focus {
    border-color: #818cf8;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .primary {
    padding: 0 16px;
    border: 0;
    border-radius: var(--radius);
    background: var(--text);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }

  .secondary {
    display: grid;
    place-items: center;
    padding: 0 14px;
    border: 1px solid #d1d5db;
    border-radius: var(--radius);
    background: #fff;
    font: inherit;
    color: var(--text-2);
    cursor: pointer;
  }

  .secondary:disabled {
    cursor: progress;
  }

  .examples {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: 12px;
  }

  .examples button {
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
  }

  .examples button:hover {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  @media (max-width: 700px) {
    form {
      flex-wrap: wrap;
    }
    input[type="text"] {
      flex-basis: 100%;
      font-size: 16px;
    }
    .primary,
    .secondary {
      flex: 1;
      height: 40px;
    }
    .examples {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .examples button {
      white-space: nowrap;
    }
  }
</style>
