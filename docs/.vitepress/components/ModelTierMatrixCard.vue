<script setup>
// Frameless "model selection" decision-matrix card: the three task-complexity
// tiers from guide/best-practices.md ("Match model capability to task
// complexity"), rendered as scannable rows — each tier names its task kind, a
// one-line cue, and the recommended model handles as accent chips. Reads as
// "pick the row that matches your task, then grab a model" rather than a flat
// bullet list. Model handles match the page exactly.
//
// Card shell + inline mono header come by COMPOSITION from the shared <MockCard>
// primitive, so the `--mk-*` colour + dimensional tokens resolve here and the
// card flips cleanly between the docs light / dark themes.
import MockCard from './MockCard.vue';

// Each tier: icon · task kind · one-line cue · recommended model handles.
const tiers = [
  {
    icon: 'bolt',
    kind: 'Simple',
    cue: 'Corrections, quick edits',
    models: ['gpt56--', 'deepseek', 'haiku45'],
  },
  {
    icon: 'sparkle',
    kind: 'Complex',
    cue: 'Transformations, rewrites',
    models: ['fable5', 'opus5T', 'gpt56', 'gemini31p'],
  },
  {
    icon: 'lightbulb',
    kind: 'Reasoning-heavy',
    cue: 'Deep, multi-step thinking',
    models: ['fable5', 'sonnet5T', 'opus5T', 'deepseekT'],
  },
];
</script>

<template>
  <MockCard
    title="Match model to task"
    icon="gear"
    sub="capability vs. complexity"
    class="tier-matrix"
  >
    <div class="tm-rows">
      <div v-for="t in tiers" :key="t.kind" class="tm-row">
        <div class="tm-head">
          <wa-icon class="tm-ic" library="texra" :name="t.icon"></wa-icon>
          <span class="tm-kind">{{ t.kind }}</span>
          <span class="tm-cue">{{ t.cue }}</span>
        </div>
        <div class="tm-models">
          <code v-for="m in t.models" :key="m" class="tm-chip">{{ m }}</code>
        </div>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + inline mono header come by composition from <MockCard>, which
   owns the header spacing. Everything below scopes the tier rows. */
.tm-rows {
  margin-top: var(--mk-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
}
.tm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--mk-space-8);
  padding: var(--mk-space-8) var(--mk-space-10);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-md);
}
.tm-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  min-width: 0;
}
.tm-ic {
  align-self: center;
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.tm-kind {
  font-size: var(--mk-fs-80);
  font-weight: 600;
  color: var(--mk-text);
}
.tm-cue {
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
}
.tm-models {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
}
.tm-chip {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-6);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
}

@media (max-width: 560px) {
  .tm-cue {
    flex-basis: 100%;
    padding-left: var(--mk-space-20);
  }
}
</style>
