<script setup>
// A real Web Awesome <wa-switch>, bridged to the --mk-* palette so it themes to
// the mockup surface and flips with the docs light/dark theme. Replaces the two
// hand-rolled role=switch buttons (ApiKeysHero, MemoryHero) with one accessible
// primitive and demonstrates a bridged wa-* control inside a figure.
//
// Bridging: theme/mockup.css maps --wa-form-control-* onto --mk-* on `.mockup`;
// this component pins the switch dimensions and the off-track/on colors to the
// same tokens the old .switch used (medium grey off, brand purple on, white
// knob), so the toggle reads in both themes.
const model = defineModel({ type: Boolean, default: false });
defineProps({
  label: { type: String, default: '' },
  description: { type: String, default: '' },
});
function onToggle(e) {
  model.value = !!e.target.checked;
}
</script>

<template>
  <div class="mk-switch-row">
    <wa-switch
      class="mk-switch"
      :checked="model"
      @change="onToggle"
      @input="onToggle"
      >{{ label }}</wa-switch
    >
    <span v-if="description" class="mk-switch-desc">{{ description }}</span>
  </div>
</template>

<style scoped>
.mk-switch-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
}
.mk-switch {
  /* Match the old hand-rolled .switch geometry (32×18 track, 14 knob). */
  --width: var(--mk-size-32);
  --height: var(--mk-space-18);
  --thumb-size: var(--mk-space-14);
  /* Off-track stays a medium grey so the white knob keeps contrast in BOTH
     themes (same intent as the old .switch); on-track is the brand purple. */
  --wa-form-control-background-color: var(--mk-text-faint);
  --wa-form-control-border-color: var(--mk-text-faint);
  --wa-form-control-activated-color: var(--mk-accent);
  font-size: var(--mk-fs-78);
  color: var(--mk-text-dim);
}
.mk-switch-desc {
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
}
</style>
