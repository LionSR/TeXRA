<script setup>
// Frameless search-results slice: what the `search` agent hands back after a
// literature query — the "table of relevant arXiv preprints with titles,
// authors, and abstracts" the Find Papers user story describes but never shows.
// Standalone (no MockupFrame) — just the focused results card, built on the
// shared <MockCard> shell so it flips cleanly between docs light / dark themes.
//
// Each row mirrors MemoryHero's .mem-item / .mem-meta vocabulary: a title, a
// dimmed authors line, then a dot-separated metadata strip carrying the id and
// a per-row source badge (arXiv vs Crossref) so the dual arXiv + Crossref
// sourcing the prose names is visible at a glance, plus a Cite action chip.
import MockCard from './MockCard.vue';

const query = 'efficient self-attention for long documents';

const results = [
  {
    title: 'Longformer: The Long-Document Transformer',
    authors: 'Beltagy, Peters, Cohan',
    id: 'arXiv:2004.05150',
    source: 'arXiv',
  },
  {
    title: 'Efficient Attention: Attention with Linear Complexities',
    authors: 'Shen, Zhang, Zhao, Yi, Li',
    id: 'arXiv:1812.01243',
    source: 'arXiv',
  },
  {
    title: 'Rethinking Attention with Performers',
    authors: 'Choromanski et al.',
    id: '10.48550/arXiv.2009.14794',
    source: 'Crossref',
  },
];
</script>

<template>
  <MockCard class="sr-card" icon="mortar-board" title="search" sub="results">
    <!-- Echo the query the way the agent reflects it back. -->
    <div class="sr-query">
      <wa-icon class="sr-q-ic" library="texra" name="mortar-board"></wa-icon>
      <span class="sr-q-text">{{ query }}</span>
    </div>

    <ul class="sr-list">
      <li v-for="(r, i) in results" :key="i" class="sr-item">
        <div class="sr-main">
          <div class="sr-title">{{ r.title }}</div>
          <div class="sr-authors">{{ r.authors }}</div>
          <div class="sr-meta">
            <span class="sr-src" :class="`sr-src--${r.source.toLowerCase()}`">{{
              r.source
            }}</span>
            <span class="meta-dot">·</span>
            <span class="sr-id">{{ r.id }}</span>
          </div>
        </div>
        <button type="button" class="sr-cite">
          <wa-icon library="texra" name="link"></wa-icon>
          Cite
        </button>
      </li>
    </ul>

    <div class="sr-foot">
      <wa-icon library="texra" name="shield"></wa-icon>
      Every result is a real arXiv or Crossref lookup — never fabricated.
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + mono header come from the shared <MockCard> primitive (the
   .mk-card* family in theme/mockup.css). Only the results body is scoped here. */
.sr-card {
  font-family: var(--vp-font-family-base);
}

/* Query echo */
.sr-query {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-6) var(--mk-space-9);
  margin-bottom: var(--mk-space-10);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
}
.sr-q-ic {
  color: var(--mk-accent);
  font-size: var(--mk-space-13);
  flex-shrink: 0;
}
.sr-q-text {
  font-size: var(--mk-fs-78);
  color: var(--wa-color-text-normal);
  font-style: italic;
}

/* Result rows — borrow MemoryHero's .mem-item card look. */
.sr-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
}
.sr-item {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
  background: var(--mk-bg-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-12);
}
.sr-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
}
.sr-title {
  font-size: var(--mk-fs-80);
  font-weight: 600;
  color: var(--wa-color-text-normal);
  line-height: 1.35;
}
.sr-authors {
  font-size: var(--mk-fs-74);
  color: var(--color-text-secondary);
}

/* Metadata strip (source badge · id) — mirrors .mem-meta. */
.sr-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
  margin-top: var(--mk-space-2);
}
.meta-dot {
  color: var(--color-text-tertiary);
}
.sr-id {
  font-family: var(--vp-font-family-mono);
  color: var(--color-text-link);
}
.sr-src {
  font-weight: 600;
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-size: var(--mk-fs-68);
}
.sr-src--arxiv {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
}
.sr-src--crossref {
  color: var(--mk-syn-fn);
  background: color-mix(in srgb, var(--mk-syn-fn) 12%, transparent);
}

/* Cite action chip */
.sr-cite {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  flex-shrink: 0;
  font-size: var(--mk-fs-72);
  color: var(--wa-color-text-normal);
  background: var(--mk-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-4) var(--mk-space-10);
  cursor: pointer;
}
.sr-cite:hover {
  background: var(--mk-border-soft);
}
.sr-cite wa-icon {
  font-size: var(--mk-space-11);
  color: var(--color-text-secondary);
}

/* Grounding footer */
.sr-foot {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  margin-top: var(--mk-space-10);
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
}
.sr-foot wa-icon {
  color: var(--mk-accent);
  font-size: var(--mk-space-12);
  flex-shrink: 0;
}

/* Stack the cite action under the result on narrow screens. */
@media (max-width: 560px) {
  .sr-item {
    flex-direction: column;
    align-items: stretch;
  }
  .sr-cite {
    align-self: flex-start;
  }
}
</style>
