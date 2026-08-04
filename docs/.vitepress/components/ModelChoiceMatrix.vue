<script setup>
// Frameless decision matrix for the "Choosing a Model" section. The prose is a
// task-category -> recommended-model-ids mapping (a list a reader scans to pick
// a model by intent, not a reference table like the per-provider tables above).
// Each row: an icon + the use case, a one-line qualifier, and the recommended
// model ids as mono code chips (reusing StatusPill shape="chip" so the ids read
// as code). .mockup-scoped, so it flips with the docs theme.
import StatusPill from './StatusPill.vue';

const rows = [
  {
    icon: 'bolt',
    use: 'Simple tasks',
    note: 'Fast, cheap models',
    models: ['gpt56--', 'deepseek', 'haiku45'],
  },
  {
    icon: 'chart-line',
    use: 'Complex tasks',
    note: 'Powerful flagship models',
    models: ['fable5', 'opus5', 'gpt56', 'gemini31p'],
  },
  {
    icon: 'code',
    use: 'Code-heavy / LaTeX editing',
    note: 'Strong editing models',
    models: ['opus5T', 'sonnet5T', 'gpt56'],
  },
  {
    icon: 'sparkle',
    use: 'Reasoning-heavy',
    note: 'Thinking models',
    models: ['fable5', 'opus5T', 'sonnet5T', 'deepseekT', 'kimi3'],
  },
  {
    icon: 'file-lines',
    use: 'Large documents',
    note: 'High-context models',
    models: ['gemini31p', 'fable5', 'sonnet5', 'opus5'],
  },
];
</script>

<template>
  <div class="mockup mcm" role="group" aria-label="Model choice by use case">
    <section v-for="(r, i) in rows" :key="i" class="mcm-row">
      <header class="mcm-head">
        <wa-icon class="mcm-ic" library="texra" :name="r.icon"></wa-icon>
        <span class="mcm-use">{{ r.use }}</span>
        <span class="mcm-note">{{ r.note }}</span>
      </header>
      <div class="mcm-models">
        <StatusPill
          v-for="(m, j) in r.models"
          :key="j"
          variant="accent"
          shape="chip"
          >{{ m }}</StatusPill
        >
      </div>
    </section>
  </div>
</template>

<style scoped>
.mcm {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  margin: var(--mk-space-16) 0;
  max-width: var(--mk-size-520);
  font-family: var(--vp-font-family-base);
}
.mcm-row {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-13);
}
.mcm-head {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-8);
  flex-wrap: wrap;
}
.mcm-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
  flex-shrink: 0;
  transform: translateY(2px);
}
.mcm-use {
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.mcm-note {
  font-size: var(--mk-fs-78);
  color: var(--color-text-secondary);
}
.mcm-models {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
  padding-left: var(--mk-space-22);
}
</style>
