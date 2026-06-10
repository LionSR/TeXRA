<script setup>
// Frameless agent catalog for guide/built-in-agents.md's "Quick Reference". The
// source is an 18-row markdown table whose "Type" column is the page's central
// idea — every built-in agent is either a tool-use loop or a workflow pipeline.
// A flat table makes the reader scan that column to reconstruct the split;
// rendering the catalog as two grouped cards makes the split the figure itself,
// pairing directly with <AgentModeShapes> below (which then explains how each of
// the two shapes behaves). Agent name → mono chip, purpose → gloss; the per-row
// alignment comes from a shared max-content column so names line up per card.
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, and the
// per-card count from <StatusPill>, so the `--mk-*` colour + dimensional tokens
// resolve here and the catalog flips cleanly between the docs light / dark
// themes. Names + purposes mirror the Quick Reference table verbatim.
import MockCard from './MockCard.vue';
import StatusPill from './StatusPill.vue';

const groups = [
  {
    title: 'Tool-use',
    icon: 'comments',
    agents: [
      {
        name: 'prover',
        purpose: 'Attack open math problems — recon, experiments, proofs',
      },
      {
        name: 'research',
        purpose: 'Analytical derivations & numerical programming with Wolfram',
      },
      { name: 'review', purpose: 'Mathematical and manuscript verification' },
      {
        name: 'numerics',
        purpose: 'Design, run, and validate computational experiments',
      },
      { name: 'lean', purpose: 'Lean 4 proof development' },
      {
        name: 'presenter',
        purpose: 'Interactive presentation and poster builder',
      },
      {
        name: 'latexFixer',
        purpose: 'Diagnose and fix LaTeX compile errors, warnings, bad boxes',
      },
      {
        name: 'latexDiff',
        purpose: 'Generate a visual latexdiff PDF between two versions',
      },
      { name: 'creator', purpose: 'Design, write, and test new TeXRA agents' },
      { name: 'setup', purpose: 'Setup wizard — diagnose, install, configure' },
      { name: 'chat', purpose: 'General assistance & file editing (opt-in)' },
    ],
  },
  {
    title: 'Workflow',
    icon: 'diagram-project',
    agents: [
      { name: 'correct', purpose: 'Fix errors without style changes' },
      { name: 'polish', purpose: 'Improve writing quality' },
      { name: 'paper2slide', purpose: 'Convert papers to beamer slides' },
      { name: 'paper2poster', purpose: 'Create academic posters' },
      { name: 'ocr', purpose: 'Extract text from images / PDFs' },
      { name: 'transcribe_audio', purpose: 'Transcribe audio to text' },
      { name: 'merge', purpose: 'Intelligently merge document versions' },
    ],
  },
];
</script>

<template>
  <div
    class="mockup ac-cat"
    role="group"
    aria-label="Built-in agents by execution type"
  >
    <MockCard
      v-for="(g, gi) in groups"
      :key="gi"
      :icon="g.icon"
      :title="g.title"
    >
      <template #head>
        <StatusPill class="ac-count" variant="neutral" shape="pill"
          >{{ g.agents.length }} agents</StatusPill
        >
      </template>
      <div class="ac-rows">
        <template v-for="(a, i) in g.agents" :key="i">
          <code class="ac-name">{{ a.name }}</code>
          <span class="ac-purpose">{{ a.purpose }}</span>
        </template>
      </div>
    </MockCard>
  </div>
</template>

<style scoped>
.ac-cat {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
@media (max-width: 640px) {
  .ac-cat {
    grid-template-columns: minmax(0, 1fr);
  }
}
.ac-count {
  margin-left: auto;
}
/* Shared max-content name column so every agent chip lines up within a card. */
.ac-rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  align-items: baseline;
  gap: var(--mk-space-5) var(--mk-space-9);
  margin-top: var(--mk-space-4);
}
.ac-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-6);
  white-space: nowrap;
}
.ac-purpose {
  font-size: var(--mk-fs-76);
  line-height: 1.45;
  color: var(--color-text-secondary);
  min-width: 0;
}
</style>
