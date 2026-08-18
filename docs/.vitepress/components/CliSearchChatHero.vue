<script setup>
// Terminal card for guide/research-tools.md "Find Papers" — the page's postdoc
// user story, streaming in a terminal. Uses the real chat-TUI vocabulary
// (packages/cli/src/chat/tui/panes/): session header with `agent: … ·
// model: …`, a `› ` reverse-video user band, `● tool (preview)` rows (dot dim
// while running, green when done) and a dim `⎿ ` result line. Tool names are
// the real grounded-search tools (src/tools/arxiv/ArxivSearchTool.ts
// `arxiv_search`, src/tools/citation/CrossrefSearchTool.ts `crossref_search`).
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings; the
// quoted paper is a real arXiv preprint, not fabricated.
</script>

<template>
  <TermWindow
    title="texra chat"
    aria-label="A literature search streaming in texra chat"
  >
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra chat <span class="mk-term-flag">--agent</span> search</span
      >
    </div>

    <div class="csr-identity">agent: search · model: deepseekT</div>

    <div class="csr-user">
      <span class="csr-chevron">›</span>
      <span class="csr-msg"
        >Find recent papers on efficient self-attention for long
        documents.</span
      >
    </div>

    <ul class="csr-tools">
      <li class="csr-call">
        <div class="csr-row">
          <span class="csr-dot csr-dot--done">●</span>
          <span class="csr-tname">arxiv_search</span>
          <span class="csr-preview"
            >(efficient self-attention long documents)</span
          >
        </div>
        <div class="csr-out">
          <span class="csr-corner">⎿</span>
          <span class="csr-out-text"
            >12 results — "Longformer: The Long-Document Transformer"
            (arXiv:2004.05150) …</span
          >
        </div>
      </li>
      <li class="csr-call">
        <div class="csr-row">
          <span class="csr-dot csr-dot--running">●</span>
          <span class="csr-tname">crossref_search</span>
          <span class="csr-preview">(efficient attention published)</span>
        </div>
      </li>
    </ul>

    <template #hint>
      <span class="csr-diamond">◆</span>
      <span class="csr-seg">running</span>
      <span class="csr-seg">API keys</span>
      <span class="csr-seg-dim"
        >every row a real lookup — arXiv + Crossref</span
      >
    </template>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, prompt, and hint strip come from TermWindow + the shared
   .mk-term-* classes in theme/mockup.css. */
.csr-identity {
  margin-top: var(--mk-space-5);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
.csr-user {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-8);
  padding: var(--mk-space-4) var(--mk-space-8);
  border-radius: var(--mk-radius-sm);
  background: var(--mk-bg-raised);
}
.csr-chevron {
  color: var(--mk-accent);
  font-weight: 700;
  flex-shrink: 0;
}
.csr-msg {
  color: var(--mk-text);
  min-width: 0;
}

.csr-tools {
  list-style: none;
  margin: var(--mk-space-8) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.csr-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.csr-dot {
  flex-shrink: 0;
}
.csr-dot--done {
  color: var(--color-success);
}
.csr-dot--running {
  color: var(--mk-text-faint);
}
.csr-tname {
  color: var(--mk-text);
  font-weight: 600;
}
.csr-preview {
  color: var(--mk-text-faint);
  min-width: 0;
}
.csr-out {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-74);
}
.csr-corner {
  flex-shrink: 0;
}
.csr-out-text {
  min-width: 0;
}

.csr-diamond {
  color: var(--mk-accent);
  font-size: var(--mk-fs-70);
}
.csr-seg {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}
.csr-seg-dim {
  margin-left: auto;
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  font-style: italic;
}

@media (max-width: 560px) {
  .csr-seg-dim {
    margin-left: 0;
    flex-basis: 100%;
  }
}
</style>
