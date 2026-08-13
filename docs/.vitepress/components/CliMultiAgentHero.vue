<script setup>
// Terminal card for `texra multi-agent run` — the Multi-Agent Teams section of
// guide/texra-cli.md. Shows the orchestrator-and-delegates shape the TUI
// actually renders: the team's lead agent at work, then the subagent panel's
// numbered child rows (status marker colored by child state, agent label,
// status, elapsed, one dim output tail line — packages/cli/src/chat/tui's
// subagent panel), with the stream-focus bindings in the bottom strip. Team id
// and agent names match the built-in Software Engineer preset (lead `engineer`
// delegating to `coder`, `testEngineer`, …) quoted in the surrounding prose.
//
// Built on <TermWindow>; .mockup-scoped, so the shared --mk-* tokens resolve
// here and the card flips with the docs theme. Believable static strings only.
const children = [
  {
    n: 1,
    agent: 'coder',
    status: 'completed',
    elapsed: '48s',
    tail: 'optimized the inner loop in scripts/simulate.py',
  },
  {
    n: 2,
    agent: 'testEngineer',
    status: 'running',
    elapsed: '21s',
    tail: 'pytest -q  ·  17 passed, 3 to go',
  },
];
</script>

<template>
  <TermWindow
    title="texra multi-agent"
    aria-label="texra multi-agent run with delegating subagents"
  >
    <!-- Prompt line -->
    <div class="mk-term-prompt cma-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra multi-agent run software-engineer
        <span class="mk-term-flag">--instruction</span> "Profile and speed up
        scripts/simulate.py"</span
      >
    </div>

    <!-- Orchestrator row: the team's lead plans and delegates -->
    <div class="cma-root">
      <wa-spinner class="cma-spin mk-spinner"></wa-spinner>
      <span class="cma-agent">engineer</span>
      <span class="cma-status">running</span>
      <span class="cma-elapsed">1m 12s</span>
    </div>

    <!-- Subagent panel rows: numbered children with status + output tail -->
    <ul class="cma-children">
      <li v-for="c in children" :key="c.n" class="cma-child">
        <div class="cma-child-row">
          <span class="cma-n">{{ c.n }}</span>
          <span class="cma-marker">●</span>
          <span class="cma-agent">{{ c.agent }}</span>
          <span class="cma-status">{{ c.status }}</span>
          <span class="cma-elapsed">{{ c.elapsed }}</span>
        </div>
        <div class="cma-tail">
          <span class="cma-tail-text">{{ c.tail }}</span>
        </div>
      </li>
    </ul>

    <!-- Stream-focus bindings: each child is a focusable scoped transcript -->
    <template #hint>
      <span class="cma-bindings"
        >[Tab]streams&ensp;[Esc 1..9]focus&ensp;[Esc s]subagents</span
      >
      <span class="cma-hint-note">each subagent keeps its own transcript</span>
    </template>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, prompt, and hint strip come from TermWindow + the shared
   .mk-term-* classes in theme/mockup.css. */
.cma-prompt {
  flex-wrap: wrap;
}

.cma-root {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  margin-top: var(--mk-space-9);
}
.cma-spin {
  font-size: var(--mk-space-11);
  flex-shrink: 0;
}
.cma-agent {
  color: var(--mk-syn-fn);
  font-weight: 600;
}
.cma-status {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
.cma-elapsed {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
}

.cma-children {
  list-style: none;
  margin: var(--mk-space-7) 0 0;
  padding: 0 0 0 var(--mk-space-16);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.cma-child-row {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
}
.cma-n {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
  flex-shrink: 0;
}
/* Both child markers are green: childStatusColor colors running and
   completed children alike in the real subagent panel. */
.cma-marker {
  flex-shrink: 0;
  color: var(--color-success);
}
.cma-tail {
  padding-left: var(--mk-space-26);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
.cma-tail-text {
  min-width: 0;
}

.cma-bindings {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
}
.cma-hint-note {
  margin-left: auto;
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  font-style: italic;
}

@media (max-width: 560px) {
  .cma-hint-note {
    margin-left: 0;
    flex-basis: 100%;
  }
}
</style>
