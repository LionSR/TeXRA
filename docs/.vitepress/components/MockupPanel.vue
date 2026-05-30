<script setup>
// The FRAMELESS counterpart to MockupFrame. Renders a single focused TeXRA
// surface — a titled panel or a bare card — WITHOUT the VS Code window chrome
// (no traffic-light bar, no activity bar). Use it to show ONE component on its
// own: a tool-call log, a settings control, a roster, a diff hunk.
//
// The root carries `.mockup`, so it inherits the entire --mk-* token block AND
// the litStyles alias bridge (--color-*, --brand, --wa-* WebAwesome bridge) that
// theme/mockup.css now defines on `.mockup` — the same scope MockupFrame uses.
// Every shared mockup.css rule and any bridged wa-* element therefore resolves
// here too, and the panel flips with the docs light/dark theme by construction.
defineProps({
  // Header label (variant='panel' only).
  title: { type: String, default: '' },
  // wa-icon name from the texra library, rendered before the title.
  icon: { type: String, default: '' },
  // Optional muted sub-line in the header, e.g. 'tool calls · this run'.
  caption: { type: String, default: '' },
  // 'panel' draws a thin header strip over a bordered card; 'bare' is the
  // bordered card alone, for content that supplies its own heading.
  variant: { type: String, default: 'panel' },
  // Optional width cap so a lone control doesn't stretch the full prose column.
  maxWidth: { type: String, default: '' },
});
</script>

<template>
  <div
    class="mockup mk-panel"
    :class="`mk-panel--${variant}`"
    :style="maxWidth ? { maxWidth } : null"
    role="group"
    :aria-label="title || undefined"
  >
    <div v-if="variant === 'panel'" class="mk-panel-head">
      <wa-icon
        v-if="icon"
        class="mk-panel-ic"
        library="texra"
        :name="icon"
      ></wa-icon>
      <span class="mk-panel-title">{{ title }}</span>
      <span v-if="caption" class="mk-panel-caption">{{ caption }}</span>
      <span class="mk-panel-head-extra"><slot name="head" /></span>
    </div>
    <div class="mk-panel-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* All tokens resolve from `.mockup` (theme/mockup.css). No raw hex / px here. */
.mk-panel {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}
.mk-panel-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-8) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border-strong);
  font-family: var(--vp-font-family-mono);
}
.mk-panel-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.mk-panel-title {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.mk-panel-caption {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  margin-left: var(--mk-space-2);
}
.mk-panel-head-extra {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-6);
}
.mk-panel-body {
  padding: var(--mk-space-12) var(--mk-space-14);
}
</style>
