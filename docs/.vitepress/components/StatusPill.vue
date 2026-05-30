<script setup>
// One consolidated pill/badge. Replaces the ~7 bespoke pill variants scattered
// across the heroes (.sh-badge, .task-tag, .ph-tag, .status--*, .odyssey,
// .mc-cmd verb chip, .pin-badge) with a single primitive + semantic variants.
// Tints match the existing hand-rolled pills verbatim so adopting it is a
// zero-regression consolidation, and the colors flip with the docs theme via
// the --mk-* / litStyles aliases (this is rendered inside a `.mockup` scope).
defineProps({
  // success | warning | info | accent | neutral
  variant: { type: String, default: 'neutral' },
  // optional leading wa-icon (texra library) name
  icon: { type: String, default: '' },
  // 'pill' (rounded) or 'chip' (mono code-chip, like .tc-code / .mc-cmd verbs)
  shape: { type: String, default: 'pill' },
});
</script>

<template>
  <span class="mk-pill" :class="[`mk-pill--${variant}`, `mk-pill--${shape}`]">
    <wa-icon
      v-if="icon"
      class="mk-pill-ic"
      library="texra"
      :name="icon"
    ></wa-icon>
    <slot />
  </span>
</template>

<style scoped>
.mk-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-68);
  font-weight: 600;
  line-height: 1.45;
  white-space: nowrap;
}
.mk-pill-ic {
  font-size: var(--mk-space-11);
}
.mk-pill--pill {
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-8);
}
.mk-pill--chip {
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-family: var(--vp-font-family-mono);
  font-weight: 500;
  font-size: var(--mk-fs-72);
}

/* Tints mirror the existing pills verbatim (accent purple at 12-14% alpha, the
   task-tag amber, link-blue, success green) so nothing shifts visually. */
.mk-pill--accent {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
}
.mk-pill--success {
  color: var(--color-success);
  background: rgba(46, 160, 67, 0.14);
}
.mk-pill--warning {
  color: #e0b341;
  background: rgba(215, 169, 62, 0.16);
}
.mk-pill--info {
  color: var(--mk-syn-fn);
  background: color-mix(in srgb, var(--mk-syn-fn) 12%, transparent);
}
.mk-pill--neutral {
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
}
</style>
