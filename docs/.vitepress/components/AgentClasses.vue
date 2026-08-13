<script setup>
// Frameless figure for the two-class agent taxonomy that the guide explains in
// two run-on prose paragraphs: workflow agents (a structured pipeline that
// writes versioned, diffable output files) vs tool-use agents (conversational,
// read/edit + search/compile with tools). Side-by-side cards make the
// dichotomy scannable; each agent becomes a labelled pill.
//
// Frameless and .mockup-scoped, so it inherits --mk-* and flips with the theme.
// Composes StatusPill for the rosters — no bespoke pill CSS.
import StatusPill from './StatusPill.vue';

const workflow = [
  'polish',
  'correct',
  'merge',
  'ocr',
  'transcribe_audio',
  'paper2slide',
  'paper2poster',
];
const toolUse = [
  'research',
  'numerics',
  'review',
  'lean',
  'presenter',
  'latexFixer',
  'latexDiff',
  'creator',
  'chat',
  'setup',
];
const tools = [
  'arXiv',
  'Crossref',
  'Lean',
  'Wolfram',
  'compile',
  'files',
  'shell',
];
</script>

<template>
  <div class="mockup ac" role="group" aria-label="Agent classes">
    <!-- Workflow agents -->
    <section class="ac-col">
      <header class="ac-head ac-head--workflow">
        <wa-icon class="ac-ic" library="texra" name="diagram-project"></wa-icon>
        <span class="ac-title">Workflow agents</span>
      </header>
      <p class="ac-sub">
        Run a structured pipeline → save versioned output files with a diff.
      </p>
      <div class="ac-badges">
        <StatusPill v-for="a in workflow" :key="a" variant="accent">{{
          a
        }}</StatusPill>
      </div>
      <footer class="ac-foot">
        <wa-icon class="ac-foot-ic" library="texra" name="file-code"></wa-icon>
        <code>.tex</code> in → improved <code>.tex</code> +
        <code>latexdiff</code>
      </footer>
    </section>

    <!-- Tool-use agents -->
    <section class="ac-col">
      <header class="ac-head ac-head--tooluse">
        <wa-icon
          class="ac-ic"
          library="texra"
          name="screwdriver-wrench"
        ></wa-icon>
        <span class="ac-title">Tool-use agents</span>
      </header>
      <p class="ac-sub">
        Work conversationally → read &amp; edit files, search, compile, iterate.
      </p>
      <div class="ac-badges">
        <StatusPill v-for="a in toolUse" :key="a" variant="info">{{
          a
        }}</StatusPill>
      </div>
      <footer class="ac-foot ac-foot--tools">
        <StatusPill v-for="t in tools" :key="t" variant="neutral">{{
          t
        }}</StatusPill>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ac {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.ac-col {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.ac-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
}
.ac-ic {
  font-size: var(--mk-space-14);
}
.ac-head--workflow .ac-ic {
  color: var(--mk-accent);
}
.ac-head--tooluse .ac-ic {
  color: var(--mk-syn-fn);
}
.ac-title {
  font-size: var(--mk-fs-90);
  font-weight: 700;
  color: var(--mk-text);
}
.ac-sub {
  margin: 0;
  font-size: var(--mk-fs-78);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.ac-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
}
.ac-foot {
  margin-top: auto;
  padding-top: var(--mk-space-8);
  border-top: 1px solid var(--mk-border);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-74);
  color: var(--color-text-secondary);
}
.ac-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--color-text-link);
  background: var(--mk-bg-raised);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-4);
}
.ac-foot-ic {
  font-size: var(--mk-space-12);
  color: var(--color-text-tertiary);
}

/* Stack the two columns on a narrow prose column. */
@media (max-width: 560px) {
  .ac {
    grid-template-columns: 1fr;
  }
}
</style>
