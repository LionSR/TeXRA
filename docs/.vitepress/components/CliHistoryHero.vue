<script setup>
// Terminal card for `texra history list` — guide/progress-board.md's proof
// that run history is shared across surfaces. Rows reproduce the real
// tab-separated format (packages/cli/src/runtime/history.ts
// formatCliHistoryText): id, ISO timestamp, agent, status, primary input —
// the same runs the ProgressBoard shows as streams. Ids are the compact
// 12-char hex execution ids; status words are the real set (completed /
// error / resumable / …); `texra resume <id>` only works on a `resumable`
// session, which it reopens in the interactive chat TUI.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
const rows = [
  {
    id: '9f3a6c81d24e',
    ts: '2025-11-04T14:31:08.412Z',
    agent: 'polish',
    status: 'completed',
    input: 'draft.tex',
  },
  {
    id: 'c4e19b07a52d',
    ts: '2025-11-04T11:02:44.917Z',
    agent: 'research',
    status: 'resumable',
    input: 'sections/intro.tex',
  },
  {
    id: 'e2c70a94b18f',
    ts: '2025-11-03T17:45:13.208Z',
    agent: 'correct',
    status: 'error',
    input: 'appendices.tex',
  },
];
</script>

<template>
  <TermWindow title="texra history" aria-label="texra history list output">
    <div class="chh-scroll">
      <div class="mk-term-prompt chh-prompt">
        <span class="mk-term-sigil">$</span>
        <span class="mk-term-cmd"
          >texra history list <span class="mk-term-flag">-n</span> 3</span
        >
      </div>
      <div v-for="r in rows" :key="r.id" class="chh-row">
        <span class="chh-id">{{ r.id }}</span>
        <span class="chh-ts">{{ r.ts }}</span>
        <span class="chh-agent">{{ r.agent }}</span>
        <span
          class="chh-status"
          :class="{
            'chh-status--bad': r.status === 'error',
            'chh-status--resume': r.status === 'resumable',
          }"
          >{{ r.status }}</span
        >
        <span class="chh-input">{{ r.input }}</span>
      </div>

      <div class="mk-term-prompt chh-resume">
        <span class="mk-term-sigil">$</span>
        <span class="mk-term-cmd">texra resume c4e19b07a52d</span>
      </div>
      <div class="chh-note">
        reopens the stored session in the chat TUI, on the saved agent and model
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes. Column-aligned output scrolls instead of reflowing. */
.chh-scroll {
  overflow-x: auto;
  font-size: var(--mk-fs-74);
}
.chh-prompt {
  margin-bottom: var(--mk-space-7);
}
.chh-row {
  display: grid;
  grid-template-columns: 0.9fr 1.2fr 0.6fr 0.7fr 1fr;
  min-width: var(--mk-size-520);
  gap: var(--mk-space-10);
  padding: var(--mk-space-3) 0;
  align-items: baseline;
}
.chh-id {
  color: var(--mk-accent);
}
.chh-ts {
  color: var(--mk-text-faint);
}
.chh-agent {
  color: var(--mk-syn-fn);
  font-weight: 600;
}
.chh-status {
  color: var(--color-success);
}
.chh-status--bad {
  color: var(--color-error);
}
.chh-status--resume {
  color: var(--mk-accent);
}
.chh-input {
  color: var(--mk-text);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chh-resume {
  margin-top: var(--mk-space-10);
}
.chh-note {
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
  font-style: italic;
}
</style>
