<script setup>
// Frameless "QA checklist" card: the five-item post-run review checklist from
// guide/best-practices.md ("Always review AI-generated content"), rendered as
// check-state rows so it reads as "the boxes to tick after every run" rather
// than a flat bullet list. Reuses the shared progress-board todo vocabulary
// (.todos / .todo / .td-ic check-circle, .td-sp pending dot) from
// theme/mockup.css, reinforcing product familiarity. The last row is left
// pending so the card reads as an in-progress review pass.
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, so the
// `--mk-*` colour + dimensional tokens resolve here and the card flips cleanly
// between the docs light / dark themes.
import MockCard from './MockCard.vue';

// Steps mirror the page's QA list exactly; `done` marks ticked rows.
const steps = [
  { label: 'Compiles without LaTeX errors', done: true },
  { label: 'Cross-references & citations resolve', done: true },
  { label: 'Figure & table numbering correct', done: true },
  { label: 'Math expressions verified', done: true },
  { label: 'No omissions or duplications', done: false },
];
</script>

<template>
  <MockCard
    title="Review every AI-generated change"
    icon="list-check"
    sub="after each run"
  >
    <div class="todos qa-todos">
      <div
        v-for="(s, i) in steps"
        :key="i"
        class="todo"
        :class="s.done ? 'done' : 'prog'"
      >
        <wa-icon
          v-if="s.done"
          class="td-ic"
          library="texra"
          name="check"
        ></wa-icon>
        <span v-else class="td-sp"></span>
        <span class="td-tx">{{ s.label }}</span>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + inline mono header come by composition from <MockCard>. The
   .todos / .todo / .td-ic / .td-sp / .td-tx vocabulary is owned by mockup.css;
   only the top spacing below the header is scoped here. */
.qa-todos {
  margin-top: var(--mk-space-4);
}
</style>
