<script lang="ts">
  const steps = [
    {
      name: "File",
      text: "Every 256 KB block laid out in file order: column segments, metadata, free and index blocks, with the headers magnified.",
    },
    { name: "Row group", text: "Click a segment to open its row group and see each column split into its segments." },
    {
      name: "Segment",
      text: "Hover or tap one for its byte range, rows, compression, min/max and the block it shares.",
    },
  ];
</script>

<div class="empty">
  <div class="strip" aria-hidden="true">
    <span style:flex=".4" class="header"></span>
    <span style:flex="3"></span>
    <span style:flex="1.2" class="validity"></span>
    <span style:flex="2.4"></span>
    <span style:flex="1" class="free"></span>
    <span style:flex="2.8"></span>
    <span style:flex=".6" class="metadata"></span>
  </div>
  <ol>
    {#each steps as step (step.name)}
      <li><b>{step.name}</b> {step.text}</li>
    {/each}
  </ol>
  <p>
    Paths on this machine are read by the local server that <code>npm run dev</code> starts; files picked with
    <b>Open file</b> never leave the browser.
  </p>
</div>

<style>
  .empty {
    margin-top: 26px;
    padding: 22px;
    border: 1px dashed var(--line);
    border-radius: 12px;
    color: #4b5563;
  }

  .strip {
    display: flex;
    gap: 2px;
    height: 22px;
    margin-bottom: 16px;
  }

  .strip span {
    border-radius: 2px;
    background: #c3c8d0;
  }

  .strip .header {
    background: #111827;
  }

  .strip .validity {
    background: #e2e5ea;
  }

  .strip .free {
    background: #fde68a;
  }

  .strip .metadata {
    background: #4b5563;
  }

  ol {
    display: grid;
    gap: 8px;
    margin: 0;
    padding-left: 18px;
  }

  b {
    display: inline-block;
    min-width: 86px;
    font-weight: 600;
    color: var(--text);
  }

  p {
    margin: 14px 0 0;
    font-size: 12px;
    color: var(--text-3);
  }

  p b {
    min-width: 0;
    font-weight: 500;
  }
</style>
