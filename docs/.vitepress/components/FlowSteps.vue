<script setup>
// Frameless horizontal sequence of stage cards joined by arrows — for pipelines
// and step walkthroughs (reflection rounds, merge flow, staged workflows). Wraps
// to a vertical stack with down-arrows on narrow screens. .mockup-scoped.
import StatusPill from './StatusPill.vue';

defineProps({
  // [{ n, icon, title, desc, chips: [{ text, variant, icon }] }]
  steps: { type: Array, default: () => [] },
});
</script>

<template>
  <div class="mockup fl" role="group">
    <template v-for="(s, i) in steps" :key="i">
      <section class="fl-step">
        <header class="fl-head">
          <span v-if="s.n != null" class="fl-n">{{ s.n }}</span>
          <wa-icon
            v-if="s.icon"
            class="fl-ic"
            library="texra"
            :name="s.icon"
          ></wa-icon>
          <span class="fl-title">{{ s.title }}</span>
        </header>
        <p v-if="s.desc" class="fl-desc">{{ s.desc }}</p>
        <div v-if="s.chips && s.chips.length" class="fl-chips">
          <StatusPill
            v-for="(ch, j) in s.chips"
            :key="j"
            :variant="ch.variant || 'accent'"
            :icon="ch.icon"
            >{{ ch.text }}</StatusPill
          >
        </div>
      </section>
      <div v-if="i < steps.length - 1" class="fl-arrow" aria-hidden="true">
        <wa-icon library="texra" name="arrow-right"></wa-icon>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fl {
  display: flex;
  align-items: stretch;
  gap: var(--mk-space-8);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.fl-step {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-12);
  min-width: 0;
}
.fl-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
}
.fl-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  flex-shrink: 0;
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-70);
  font-weight: 700;
}
.fl-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.fl-title {
  font-size: var(--mk-fs-80);
  font-weight: 600;
  color: var(--mk-text);
}
.fl-desc {
  margin: 0;
  font-size: var(--mk-fs-74);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.fl-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-4);
  margin-top: auto;
  padding-top: var(--mk-space-2);
}
.fl-arrow {
  display: flex;
  align-items: center;
  color: var(--color-text-tertiary);
  font-size: var(--mk-space-14);
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .fl {
    flex-direction: column;
  }
  .fl-arrow {
    justify-content: center;
    transform: rotate(90deg);
  }
}
</style>
