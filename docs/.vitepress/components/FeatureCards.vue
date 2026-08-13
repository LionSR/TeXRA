<script setup>
// Frameless responsive grid of feature/agent/category cards. The most reused
// figure shape across the guide (research agents, tool categories, file
// categories, task recipes, integration/tool status). Each card: an icon + mono
// title, an optional status tag, a one-line description, and an optional strip
// of chips (StatusPill). Pure data-in; .mockup-scoped so it flips with the theme.
import StatusPill from './StatusPill.vue';

defineProps({
  // [{ icon, title, desc, tag, tagVariant, accent, chips: [{ text, variant, icon }] }]
  cards: { type: Array, default: () => [] },
  // min column width before wrapping
  min: { type: String, default: '210px' },
});
</script>

<template>
  <div class="mockup fc" :style="{ '--fc-min': min }" role="group">
    <section v-for="(c, i) in cards" :key="i" class="fc-card">
      <header class="fc-head">
        <wa-icon
          v-if="c.icon"
          class="fc-ic"
          :class="c.accent === 'info' ? 'fc-ic--info' : ''"
          library="texra"
          :name="c.icon"
        ></wa-icon>
        <span class="fc-title">{{ c.title }}</span>
        <StatusPill
          v-if="c.tag"
          class="fc-tag"
          :variant="c.tagVariant || 'neutral'"
          >{{ c.tag }}</StatusPill
        >
      </header>
      <p v-if="c.desc" class="fc-desc">{{ c.desc }}</p>
      <div v-if="c.chips && c.chips.length" class="fc-chips">
        <StatusPill
          v-for="(ch, j) in c.chips"
          :key="j"
          :variant="ch.variant || 'neutral'"
          :icon="ch.icon"
          >{{ ch.text }}</StatusPill
        >
      </div>
    </section>
  </div>
</template>

<style scoped>
.fc {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--fc-min), 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.fc-card {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.fc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
}
.fc-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.fc-ic--info {
  color: var(--mk-syn-fn);
}
.fc-title {
  font-size: var(--mk-fs-84);
  font-weight: 700;
  color: var(--mk-text);
  font-family: var(--vp-font-family-mono);
}
.fc-tag {
  margin-left: auto;
}
.fc-desc {
  margin: 0;
  font-size: var(--mk-fs-78);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.fc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
  margin-top: auto;
  padding-top: var(--mk-space-4);
}
</style>
