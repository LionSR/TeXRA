<script setup>
// Frameless memory-tool slice: how a tool-use agent actually drives the
// `memory` tool over a run, as it surfaces in the ProgressBoard / CLI tool-call
// log. Standalone (no MockupFrame / dash-nav) — just the focused tool-call
// card. Mirrors the verb set documented in guide/memory.md (view · create ·
// str_replace · insert · delete · rename · pin · unpin); a believable handful
// here demonstrates the lifecycle: discover → write → edit → promote.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional
// tokens (defined in theme/mockup.css on `.mockup`) resolve here too, and the
// card flips cleanly between the docs light / dark themes.

// Each row: status dot · `memory` tool · command verb chip · target path ·
// one-line effect. `done` rows are settled; the last row is `active`.
const calls = [
  {
    state: 'done',
    cmd: 'view',
    path: '/memories',
    effect: 'Lists saved notes at session start',
  },
  {
    state: 'done',
    cmd: 'create',
    path: '/memories/project-conventions.md',
    effect: 'Writes a new note (\\eqref over \\ref, sec: prefixes)',
  },
  {
    state: 'done',
    cmd: 'str_replace',
    path: '/memories/notation.md',
    effect: 'Edits one line — \\lambda_2 is the spectral gap',
  },
  {
    state: 'active',
    cmd: 'pin',
    path: '/memories/project-conventions.md',
    effect: 'Promotes to core memory — loaded every session',
  },
];
</script>

<template>
  <div class="mockup mem-cmds" role="group" aria-label="memory tool calls">
    <div class="mc-head">
      <wa-icon class="mc-head-ic" library="texra" name="database"></wa-icon>
      <span class="mc-head-name">memory</span>
      <span class="mc-head-sub">tool calls · this run</span>
    </div>
    <ul class="mc-list">
      <li
        v-for="(c, i) in calls"
        :key="i"
        class="mc-row"
        :class="{ active: c.state === 'active' }"
      >
        <span class="mc-dot" :class="`mc-dot--${c.state}`"></span>
        <span class="mc-tool">memory</span>
        <code class="mc-cmd">{{ c.cmd }}</code>
        <span class="mc-path">{{ c.path }}</span>
        <span class="mc-effect">{{ c.effect }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Standalone card. Tokens come from `.mockup` (theme/mockup.css). */
.mem-cmds {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

.mc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
  font-family: var(--vp-font-family-mono);
}
.mc-head-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.mc-head-name {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.mc-head-sub {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}

.mc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}
.mc-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  padding: var(--mk-space-6) var(--mk-space-6);
  border-radius: var(--mk-radius-md);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  line-height: 1.5;
}
.mc-row.active {
  background: rgba(130, 80, 223, 0.08);
}

.mc-dot {
  align-self: center;
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  flex-shrink: 0;
}
.mc-dot--done {
  background: var(--color-success);
}
.mc-dot--active {
  background: var(--mk-accent);
  box-shadow: 0 0 0 0 rgba(200, 155, 224, 0.6);
  animation: mk-shpulse 1.8s infinite;
}

.mc-tool {
  color: var(--mk-syn-fn);
  font-weight: 600;
  flex-shrink: 0;
}
.mc-cmd {
  color: var(--mk-accent);
  background: rgba(200, 155, 224, 0.12);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-size: var(--mk-fs-72);
  flex-shrink: 0;
}
.mc-path {
  color: var(--color-text-link);
  word-break: break-all;
  min-width: 0;
}
.mc-effect {
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-72);
  flex: 1;
  min-width: 0;
}

/* Stack the effect under the verb/path on narrow screens. */
@media (max-width: 560px) {
  .mc-effect {
    flex-basis: 100%;
    padding-left: var(--mk-space-16);
  }
}
</style>
