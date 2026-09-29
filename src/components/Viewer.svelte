<script lang="ts">
  import Allocation from "./Allocation.svelte";
  import FileSummary from "./FileSummary.svelte";
  import FileMap from "./FileMap.svelte";
  import Popover from "./Popover.svelte";
  import RowGroups from "./RowGroups.svelte";
  import Schema from "./Schema.svelte";
  import WalPanel from "./WalPanel.svelte";
  import { setInspector, type Inspector } from "../lib/inspector.svelte";
  import { publishQuery, toQuery } from "../lib/share";

  let { inspector }: { inspector: Inspector } = $props();
  // The parent re-creates this component per file, so the inspector never changes underneath it.
  // svelte-ignore state_referenced_locally
  setInspector(inspector);

  $effect(() => {
    const { source, selectedRg, selectedLeaf, model } = inspector;
    if (source === null) return;
    const col = selectedLeaf === null ? null : (model.leaves[selectedLeaf]?.name ?? null);
    publishQuery(toQuery({ db: source, table: inspector.table?.qualified ?? null, rg: selectedRg, col }));
  });
</script>

<svelte:document onclick={() => inspector.hidePopover()} />

<main>
  <FileSummary />
  <FileMap />
  <Allocation />
  <WalPanel view={inspector.walView} />
  <div class="columns">
    <Schema />
    <RowGroups />
  </div>
</main>

<Popover />

<style>
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
    margin-top: 18px;
  }

  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 18px;
    align-items: start;
  }

  @media (max-width: 900px) {
    .columns {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
