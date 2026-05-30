<script setup>
// Frameless symptom→fix grid for guide/tikz-figures.md's "Troubleshooting TikZ
// Issues" section. The source prose was three separate numbered lists — one per
// failure mode (compilation errors, missing packages, figure-size issues) —
// each with a handful of concrete remedies. That is the scan-not-read shape a
// reader hits when a figure won't build: render it as a card per symptom (mono
// title + a leading status pill + remedy rows) so the reader jumps straight to
// their failure mode instead of reading all three lists.
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, so the
// `--mk-*` colour + dimensional tokens resolve here and the cards flip cleanly
// between the docs light / dark themes. The .todos / .todo / .td-* row vocab is
// owned by theme/mockup.css (same as InstallTroubleshootCards / QaChecklistCard),
// reinforcing familiarity across the guide.
import MockCard from './MockCard.vue';
import StatusPill from './StatusPill.vue';

// Mirrors the page's three troubleshooting subsections verbatim; one card each.
const issues = [
  {
    icon: 'error',
    title: 'Compilation errors',
    fixes: [
      'Check the LaTeX log for the error (build directory)',
      'Verify required TikZ libraries are in the template',
      'Ensure your distribution has the needed packages',
      'Simplify figures that may exceed compiler limits',
    ],
  },
  {
    icon: 'package',
    title: 'Missing packages',
    fixes: [
      'Install packages via your LaTeX distribution manager',
      'Add the packages to your TikZ template',
      'Ensure package paths are in TEXINPUTS',
    ],
  },
  {
    icon: 'symbol-ruler',
    title: 'Figure size issues',
    fixes: [
      'Adjust the border in the standalone document class',
      'Scale the figure with TikZ’s scale option',
      'Resize specific elements, not the whole figure',
    ],
  },
];
</script>

<template>
  <div class="mockup tzt-grid" role="group">
    <MockCard
      v-for="(it, i) in issues"
      :key="i"
      :title="it.title"
      :icon="it.icon"
    >
      <template #head>
        <StatusPill class="tzt-pill" variant="warning" shape="pill"
          >fix</StatusPill
        >
      </template>
      <div class="todos tzt-todos">
        <div v-for="(f, j) in it.fixes" :key="j" class="todo">
          <wa-icon class="td-ic" library="texra" name="check"></wa-icon>
          <span class="td-tx">{{ f }}</span>
        </div>
      </div>
    </MockCard>
  </div>
</template>

<style scoped>
.tzt-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
@media (max-width: 820px) {
  .tzt-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.tzt-todos {
  margin-top: var(--mk-space-4);
}
.tzt-pill {
  margin-left: auto;
}
</style>
