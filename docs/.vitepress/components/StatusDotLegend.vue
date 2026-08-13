<script setup>
// Frameless status-indicator legend for the ProgressBoard guide. The prose
// enumerates the live status-dot states as colored circles; a swatch legend
// beats parsing "a colored circle shows the current status" four times.
//
// Colors mirror src/shared/styles/statusIndicatorStyles.ts: running = green,
// waiting = link blue, completed/cancelled = grey, failed = red. No state
// pulses in the live UI. Root carries `.mockup` so every --mk-* token
// resolves and the figure flips with the theme.
const states = [
  {
    cls: 'd-run',
    label: 'Running',
    desc: 'Agent is actively processing',
  },
  {
    cls: 'd-wait',
    label: 'Waiting',
    desc: 'Paused for your input or a follow-up',
  },
  {
    cls: 'd-done',
    label: 'Completed',
    desc: 'Finished (or cancelled) — grey',
  },
  { cls: 'd-err', label: 'Failed', desc: 'The run hit an error' },
];
</script>

<template>
  <div class="mockup sdl" role="group" aria-label="Status indicator legend">
    <div v-for="s in states" :key="s.label" class="sdl-row">
      <span class="sdl-dot" :class="s.cls"></span>
      <span class="sdl-label">{{ s.label }}</span>
      <span class="sdl-desc">{{ s.desc }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Frameless card shell — mirrors the other frameless figures (StreamHeaderActions). */
.sdl {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  max-width: var(--mk-size-420, 420px);
  padding: var(--mk-space-12) var(--mk-space-14);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-9);
  font-family: var(--vp-font-family-base);
}
.sdl-row {
  display: grid;
  grid-template-columns: var(--mk-space-12) max-content 1fr;
  align-items: center;
  gap: var(--mk-space-10);
}
.sdl-dot {
  width: var(--mk-space-10);
  height: var(--mk-space-10);
  border-radius: 50%;
  flex-shrink: 0;
}
.sdl-dot.d-run {
  background: var(--color-success);
}
.sdl-dot.d-wait {
  background: var(--wa-color-text-link, var(--mk-accent));
}
.sdl-dot.d-done {
  background: var(--mk-text-faint);
}
.sdl-dot.d-err {
  background: var(--color-error);
}
.sdl-label {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.sdl-desc {
  font-size: var(--mk-fs-72);
  line-height: 1.3;
  color: var(--mk-text-faint);
}
</style>
