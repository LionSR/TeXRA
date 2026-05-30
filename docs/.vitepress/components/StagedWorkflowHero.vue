<script setup>
// Frameless "staged workflow" card: the five-stage research-to-finalization
// pipeline from guide/best-practices.md, rendered as numbered stage rows joined
// by a connecting rail so the progression reads at a glance. Each stage names
// the agent(s) that own it as accent verb-chips, reusing the .mc-cmd chip look
// from MemoryCommandsHero. Standalone (no MockupFrame) — the focused pipeline
// card only.
//
// The card shell + inline mono header come by COMPOSITION from the shared
// <MockCard> primitive, so the `--mk-*` colour + dimensional tokens resolve here
// too and the card flips cleanly between the docs light / dark themes.
import MockCard from './MockCard.vue';

// Each stage: number · icon · stage name · one-line purpose · owning agent(s)
// rendered as accent verb-chips. Agent names match those on the page exactly.
const stages = [
  {
    icon: 'mortar-board',
    name: 'Research',
    purpose: 'Find papers and verify ideas',
    agents: ['search', 'research'],
  },
  {
    icon: 'pencil',
    name: 'Writing',
    purpose: 'Draft LaTeX content interactively',
    agents: ['research', 'orchestrator'],
  },
  {
    icon: 'sparkle',
    name: 'Development',
    purpose: 'Refine clarity and style',
    agents: ['polish'],
  },
  {
    icon: 'file-media',
    name: 'Visualization',
    purpose: 'Produce figures and slides',
    agents: ['research', 'presenter'],
  },
  {
    icon: 'check',
    name: 'Finalization',
    purpose: 'Proofread the finished draft',
    agents: ['correct'],
  },
];
</script>

<template>
  <MockCard
    title="Staged workflow"
    icon="diagram-project"
    sub="research → finalization"
    class="staged"
  >
    <ol class="sw-list">
      <li v-for="(s, i) in stages" :key="i" class="sw-row">
        <span class="sw-rail" aria-hidden="true">
          <span class="sw-n">{{ i + 1 }}</span>
          <span v-if="i < stages.length - 1" class="sw-line"></span>
        </span>
        <div class="sw-body">
          <div class="sw-title">
            <wa-icon class="sw-ic" library="texra" :name="s.icon"></wa-icon>
            <span class="sw-name">{{ s.name }}</span>
            <span class="sw-purpose">{{ s.purpose }}</span>
          </div>
          <div class="sw-agents">
            <code v-for="a in s.agents" :key="a" class="sw-cmd">{{ a }}</code>
          </div>
        </div>
      </li>
    </ol>
  </MockCard>
</template>

<style scoped>
/* Card shell + inline mono header come by composition from <MockCard>, which
   owns the header spacing. Everything below scopes the stage-list body. */
.sw-list {
  list-style: none;
  margin: var(--mk-space-4) 0 0;
  padding: 0;
}
.sw-row {
  display: flex;
  align-items: stretch;
  gap: var(--mk-space-10);
}

/* Numbered rail with a connecting line that signals progression. */
.sw-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}
.sw-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  flex-shrink: 0;
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-72);
  font-weight: 700;
  font-family: var(--vp-font-family-mono);
}
.sw-line {
  flex: 1;
  width: 0;
  border-left: 1px dashed var(--mk-border);
  margin: var(--mk-space-2) 0;
  min-height: var(--mk-space-12);
}

.sw-body {
  flex: 1;
  min-width: 0;
  padding: var(--mk-space-4) 0 var(--mk-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-5);
}
.sw-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.sw-ic {
  align-self: center;
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.sw-name {
  font-size: var(--mk-fs-80);
  font-weight: 600;
  color: var(--mk-text);
}
.sw-purpose {
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
}

.sw-agents {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
}
.sw-cmd {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-6);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
}

@media (max-width: 560px) {
  .sw-purpose {
    flex-basis: 100%;
    padding-left: var(--mk-space-18);
  }
}
</style>
