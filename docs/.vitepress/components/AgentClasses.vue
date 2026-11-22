<script setup>
// Frameless figure for the two ways TeXRA works that guide/index.md
// explains: a document program (a structured pipeline that writes
// versioned, diffable output files) vs the assistant's chat
// (conversational, read/edit + search/compile with tools), which also
// starts the task programs. Each program becomes a labelled pill.
//
// Frameless and .mockup-scoped, so it inherits --mk-* and flips with the theme.
// Composes StatusPill for the program lists — no bespoke pill CSS.
import StatusPill from './StatusPill.vue';

const workflow = [
  'edit',
  'annotate',
  'enhance',
  'apply',
  'merge',
  'transcribe',
  'slides',
  'poster',
];
const toolUse = [
  'review',
  'search',
  'derive',
  'solve',
  'experiment',
  'code',
  'review-code',
  'simplify',
  'test',
  'fix-latex',
  'latexdiff',
];
const tools = ['arXiv', 'Lean', 'Wolfram', 'compile', 'files', 'shell'];
</script>

<template>
  <div class="mockup ac" role="group" aria-label="Programs and the assistant">
    <!-- Programs -->
    <section class="ac-col">
      <header class="ac-head ac-head--workflow">
        <wa-icon class="ac-ic" library="texra" name="diagram-project"></wa-icon>
        <span class="ac-title">Document programs</span>
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

    <!-- The assistant and the task programs it starts -->
    <section class="ac-col">
      <header class="ac-head ac-head--tooluse">
        <wa-icon
          class="ac-ic"
          library="texra"
          name="screwdriver-wrench"
        ></wa-icon>
        <span class="ac-title">The assistant</span>
      </header>
      <p class="ac-sub">
        Works conversationally → read &amp; edit files, search, compile,
        iterate, or start a task program.
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
