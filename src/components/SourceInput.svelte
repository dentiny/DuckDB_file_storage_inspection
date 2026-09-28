<script lang="ts">
  interface Props {
    value: string;
    onsubmit: (value: string) => void;
    onfile: (file: File) => void;
  }

  let { value = $bindable(), onsubmit, onfile }: Props = $props();

  const examples = [{ label: "sensors (sorted, nested types, long strings, free blocks)", value: "sensors.duckdb" }];

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (value.trim()) onsubmit(value);
  }

  function onchange(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    if (file) onfile(file);
  }
</script>

<form onsubmit={submit}>
  <input
    bind:value
    type="text"
    spellcheck="false"
    autocomplete="off"
    aria-label="DuckDB database path or URL"
    placeholder="A path on this machine, like ~/data/app.duckdb, or a URL that allows range requests"
  />
  <button type="submit" class="primary">Inspect</button>
  <label class="secondary">Open file<input type="file" accept=".duckdb,.db,.ddb" hidden {onchange} /></label>
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
    color: var(--text-2);
    cursor: pointer;
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
