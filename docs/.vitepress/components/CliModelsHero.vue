<script setup>
// Terminal card for `texra models list` / `models show` — guide/models.md
// "Customizing the Model List". The real list prints one
// `<value>\t<label>\t<status>` row per model for the current api mode
// (packages/cli/src/runtime/modelAccess.ts); `models show <id>` prints
// `id:` / `label:` / `provider:` / `status:` detail lines
// (formatCliModelDetails). Short ids are exactly what `--model` takes; labels
// are the literal llm-zoo MODEL_CONFIGS labels the command prints; the status
// column is the lowercased availability label for the current api mode —
// 'included access' when signed in to the relay, 'api key set' /
// 'openrouter key' in personal mode ('login required' / 'not included'
// appear under --all). Snapshot shows a signed-in relay session.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
const rows = [
  { id: 'fable5', label: 'Claude Fable 5', status: 'included access' },
  { id: 'opus5T', label: 'Opus 5 (Thinking)', status: 'included access' },
  {
    id: 'sonnet5T',
    label: 'Sonnet 5 (Thinking)',
    status: 'included access',
  },
  {
    id: 'deepseekT',
    label: 'DeepSeek V4 Flash (Thinking)',
    status: 'included access',
  },
];
</script>

<template>
  <TermWindow
    title="texra models"
    aria-label="texra models list and show output"
  >
    <div class="cmo-scroll">
      <!-- Beat 1: the roster for the current api mode -->
      <div class="mk-term-prompt cmo-prompt">
        <span class="mk-term-sigil">$</span>
        <span class="mk-term-cmd">texra models list</span>
      </div>
      <div v-for="r in rows" :key="r.id" class="cmo-row">
        <span class="cmo-id">{{ r.id }}</span>
        <span class="cmo-label">{{ r.label }}</span>
        <span class="cmo-status">{{ r.status }}</span>
      </div>

      <!-- Beat 2: one model's details -->
      <div class="mk-term-prompt cmo-show">
        <span class="mk-term-sigil">$</span>
        <span class="mk-term-cmd">texra models show fable5</span>
      </div>
      <div class="cmo-details">
        <div><span class="cmo-k">id:</span> fable5</div>
        <div><span class="cmo-k">label:</span> Claude Fable 5</div>
        <div><span class="cmo-k">provider:</span> anthropic</div>
        <div><span class="cmo-k">status:</span> included access</div>
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes. Column-aligned output scrolls instead of reflowing. */
.cmo-scroll {
  overflow-x: auto;
  font-size: var(--mk-fs-74);
}
.cmo-prompt {
  margin-bottom: var(--mk-space-7);
}
.cmo-row {
  display: grid;
  grid-template-columns: 0.7fr 2fr 0.7fr;
  min-width: var(--mk-size-420);
  gap: var(--mk-space-10);
  padding: var(--mk-space-3) 0;
  align-items: baseline;
}
.cmo-id {
  color: var(--mk-accent);
  font-weight: 600;
}
.cmo-label {
  color: var(--mk-text);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmo-status {
  color: var(--color-success);
}

.cmo-show {
  margin-top: var(--mk-space-10);
}
.cmo-details {
  margin-top: var(--mk-space-4);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-dim);
  font-size: var(--mk-fs-72);
}
.cmo-k {
  color: var(--mk-syn-keyword);
}
</style>
