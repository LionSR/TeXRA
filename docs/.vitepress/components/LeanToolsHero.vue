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
import MockCard from './MockCard.vue';

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
    result: { kind: 'timer', text: '0:02' },
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
    result: { kind: 'timer', text: '1:48' },
  },
];
</script>

<template>
  <MockCard
    title="lean"
    icon="beaker"
    sub="tool calls · this run"
    class="lean-tools"
  >
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
  </MockCard>
</template>

<style scoped>
/* Standalone card composed from <MockCard> (shared .mk-card frameless shell +
   inline mono header). Tool-card internals (.tcard / .tc-*) come from .mockup.
   This file adds only the list layout + the few extras the inspect payload
   needs. */

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
  /* Tint derived from the (theme-flipping) tactic color, so the bg flips with
     the text instead of staying the light-mode teal in dark. */
  background: color-mix(in srgb, var(--mk-syn-tac) 14%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-family: var(--vp-font-family-mono);
}
</style>
