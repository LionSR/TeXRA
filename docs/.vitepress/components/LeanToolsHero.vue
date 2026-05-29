<script setup>
// Frameless slice of what a Lean-capable agent actually does under the hood:
// the five Lean tools documented in guide/lean.md, rendered as tool-use cards
// the way they surface in the ProgressBoard / CLI tool-call log. Standalone
// (no MockupFrame / window chrome) — just the focused card stack.
//
// Each row reuses the `.tcard` vocabulary from theme/mockup.css (the same cards
// GuideIntroHero / MockupSidebar render): status dot · tool icon · label · the
// dim tool name · a trailing result/time. One card is expanded into its
// `.tc-body` key/value rows to show what `lean_inspect` actually returns.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// resolve here and the card flips cleanly between docs light / dark themes.

// Tool names match guide/lean.md exactly: lean_diagnostics, lean_inspect,
// lean_loogle, lean_file, lean_project.
const tools = [
  {
    icon: 'alert',
    label: 'Read diagnostics',
    tool: 'lean_diagnostics',
    result: { kind: 'ok', text: '✓ 0 errors' },
  },
  {
    icon: 'search',
    label: 'Inspect the proof state',
    tool: 'lean_inspect',
    open: true,
  },
  {
    icon: 'book',
    label: 'Search Mathlib',
    tool: 'lean_loogle',
    result: { kind: 'time', text: '0:02' },
  },
  {
    icon: 'sync',
    label: 'Refresh a stuck file',
    tool: 'lean_file',
    result: { kind: 'timer', text: '0:05' },
  },
  {
    icon: 'tools',
    label: 'Manage the project',
    tool: 'lean_project',
    result: { kind: 'time', text: '1:48' },
  },
];
</script>

<template>
  <div class="mockup lean-tools" role="group" aria-label="Lean tool calls">
    <div class="lt-head">
      <wa-icon class="lt-head-ic" library="texra" name="beaker"></wa-icon>
      <span class="lt-head-name">lean</span>
      <span class="lt-head-sub">tool calls · this run</span>
    </div>

    <div class="lt-list">
      <template v-for="(t, i) in tools" :key="i">
        <!-- Expanded card: shows the real lean_inspect return payload -->
        <div v-if="t.open" class="tcard open active">
          <div class="tcard-sum">
            <wa-icon
              class="chev tc-chev open"
              library="texra"
              name="chevron-right"
            ></wa-icon>
            <wa-icon class="tc-ic" library="texra" :name="t.icon"></wa-icon>
            <span class="tc-label"
              >{{ t.label }} · <span class="tc-tool">{{ t.tool }}</span></span
            >
            <span class="tc-time tc-ok">⊢ goal</span>
          </div>
          <div class="tc-body">
            <div class="tc-row">
              <span class="tc-k">file</span
              ><span class="tc-file">Analysis/Limits.lean</span>
            </div>
            <div class="tc-row">
              <span class="tc-k">position</span
              ><span class="tc-v">line 42</span>
            </div>
            <div class="tc-row">
              <span class="tc-k">kind</span><code class="tc-code">goal</code>
            </div>
            <div class="tc-row tc-goal">
              <span class="tc-k">result</span
              ><code class="tc-state">⊢ Continuous (f + g)</code>
            </div>
          </div>
        </div>

        <!-- Collapsed cards -->
        <div v-else class="tcard">
          <wa-icon
            class="chev tc-chev"
            library="texra"
            name="chevron-right"
          ></wa-icon>
          <wa-icon class="tc-ic" library="texra" :name="t.icon"></wa-icon>
          <span class="tc-label"
            >{{ t.label }} · <span class="tc-tool">{{ t.tool }}</span></span
          >
          <span
            class="tc-time"
            :class="{
              'tc-ok': t.result.kind === 'ok',
              'tc-timer': t.result.kind === 'timer',
            }"
            >{{ t.result.text }}</span
          >
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. Tool-card internals (.tcard / .tc-*) come from .mockup in
   theme/mockup.css; this file adds only the frameless shell + the few extras
   the inspect payload needs. */
.lean-tools {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

.lt-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
  font-family: var(--vp-font-family-mono);
}
.lt-head-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.lt-head-name {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.lt-head-sub {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}

.lt-list {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  margin-top: var(--mk-space-6);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
}

/* Result-state colouring on the trailing chip. */
.tc-ok {
  color: var(--mk-ins-text);
  font-weight: 600;
}

/* The goal-state payload row reads as a code line. */
.tc-goal {
  align-items: baseline;
}
.tc-state {
  color: var(--mk-syn-tac);
  background: rgba(14, 124, 107, 0.12);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-family: var(--vp-font-family-mono);
}
</style>
