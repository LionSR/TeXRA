<script setup>
// Compact terminal card for guide/lean.md "In the CLI" — what Lean work looks
// like without the VS Code extension underneath: the CLI spawns its own
// `lake env lean --server` (one per Lake project, as the section explains),
// then the same lean_* tools run against it. The tool name and the chat-TUI
// row vocabulary (`● tool (preview)` + dim `⎿ ` output) are real
// (packages/extension/resources/tool_use_agents/lean.yaml,
// packages/cli/src/chat/tui/panes/toolRenderers.tsx).
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
</script>

<template>
  <TermWindow
    title="texra chat"
    aria-label="A Lean check running in the CLI against lake env lean --server"
  >
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra chat <span class="mk-term-flag">--agent</span> lean</span
      >
    </div>

    <div class="cln-user">
      <span class="cln-chevron">›</span>
      <span class="cln-msg">Check Proofs/GroupTheory.lean for errors.</span>
    </div>

    <div class="cln-status">
      starting lake env lean --server (one per Lake project)
    </div>

    <div class="cln-call">
      <div class="cln-row">
        <span class="cln-dot">●</span>
        <span class="cln-tname">lean_diagnostics</span>
        <span class="cln-preview">(Proofs/GroupTheory.lean)</span>
      </div>
      <div class="cln-out">
        <span class="cln-corner">⎿</span>
        <span class="cln-out-text"
          >1 error — line 42: unknown identifier 'mul_com'</span
        >
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.cln-user {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-8);
  padding: var(--mk-space-4) var(--mk-space-8);
  border-radius: var(--mk-radius-sm);
  background: var(--mk-bg-raised);
}
.cln-chevron {
  color: var(--mk-accent);
  font-weight: 700;
  flex-shrink: 0;
}
.cln-msg {
  color: var(--mk-text);
  min-width: 0;
}

.cln-status {
  margin-top: var(--mk-space-7);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
  font-style: italic;
}

.cln-call {
  margin-top: var(--mk-space-7);
}
.cln-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.cln-dot {
  color: var(--color-success);
  flex-shrink: 0;
}
.cln-tname {
  color: var(--mk-text);
  font-weight: 600;
}
.cln-preview {
  color: var(--mk-text-faint);
  min-width: 0;
}
.cln-out {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-74);
}
.cln-corner {
  flex-shrink: 0;
}
.cln-out-text {
  min-width: 0;
}
</style>
