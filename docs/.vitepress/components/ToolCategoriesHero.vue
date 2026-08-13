<script setup>
import MockCard from './MockCard.vue';

// Frameless "Dashboard → Tools" category map: the seven tool categories a
// tool-use agent can be granted, each with its icon, a one-line capability
// sub-label, and the example tool names rendered as mono accent code-chips —
// the same `.mc-cmd` vocabulary used in MemoryCommandsHero, so each chip
// visibly reads as "a token you list in your YAML `tools:` array".
//
// Standalone (no MockupFrame). The root carries `.mockup` so the shared
// `--mk-*` colour + dimensional tokens (theme/mockup.css) resolve here and the
// card flips cleanly between the docs light / dark themes.
//
// Category icons + names + example tool names mirror the Tool-Use Agents table
// in guide/custom-agents.md verbatim.

const categories = [
  {
    icon: 'files',
    name: 'File & Shell',
    desc: 'Read, write, edit, search, and run commands in your project',
    tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'],
  },
  {
    icon: 'file-code',
    name: 'LaTeX',
    desc: 'Extract figures, TikZ, and bibliography; report compile diagnostics',
    tools: [
      'extract_figures',
      'extract_tikz_figures',
      'extract_bib_entries',
      'diagnostics',
      'texcount',
    ],
  },
  {
    icon: 'mortar-board',
    name: 'Academic Research',
    desc: 'Search arXiv and Crossref, resolve DOIs, manage Zotero',
    tools: [
      'arxiv_search',
      'arxiv_metadata',
      'download_arxiv_source',
      'crossref_search',
      'zotero_*',
    ],
  },
  {
    icon: 'globe',
    name: 'Web',
    desc: 'Fetch pages and search the internet',
    tools: ['web_search', 'web_fetch'],
  },
  {
    icon: 'symbol-operator',
    name: 'Computation',
    desc: 'Run Wolfram Language, delegate to Codex, consult another chat model',
    tools: ['wolfram', 'codex', 'inquiry'],
  },
  {
    icon: 'beaker',
    name: 'Lean 4',
    desc: 'Check Lean proofs and search Mathlib',
    tools: [
      'lean_diagnostics',
      'lean_inspect',
      'lean_loogle',
      'lean_file',
      'lean_project',
    ],
  },
  {
    icon: 'type-hierarchy',
    name: 'Memory & Workflow',
    desc: 'Persistent memory, to-do lists, sub-agent delegation',
    tools: [
      'memory',
      'todo_write',
      'plan',
      'delegate_workflow',
      'delegate_agent',
      'executions',
      'accept_run_files',
    ],
  },
];
</script>

<template>
  <MockCard
    class="tcats"
    icon="tools"
    title="Dashboard → Tools"
    sub="tools you can grant a tool-use agent"
  >
    <ul class="tcats-list">
      <li v-for="(c, i) in categories" :key="i" class="tcat">
        <header class="tcat-head">
          <wa-icon class="tcat-ic" library="texra" :name="c.icon"></wa-icon>
          <span class="tcat-name">{{ c.name }}</span>
          <span class="tcat-desc">{{ c.desc }}</span>
        </header>
        <div class="tcat-chips">
          <code v-for="(t, j) in c.tools" :key="j" class="tcat-chip">{{
            t
          }}</code>
        </div>
      </li>
    </ul>
  </MockCard>
</template>

<style scoped>
/* Card shell + inline mono header come from <MockCard> (.mk-card* family in
   theme/mockup.css). The only scoped delta on the card root is a wider vertical
   margin — it merges onto the .mk-card root via attribute inheritance. */
.tcats {
  margin: var(--mk-space-16) 0;
}

.tcats-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.tcat {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
  padding: var(--mk-space-10) var(--mk-space-4);
}
.tcat + .tcat {
  border-top: 1px solid var(--mk-border-soft);
}

.tcat-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.tcat-ic {
  align-self: center;
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.tcat-name {
  font-size: var(--mk-fs-82);
  font-weight: 700;
  color: var(--mk-text);
  flex-shrink: 0;
}
.tcat-desc {
  font-size: var(--mk-fs-76);
  line-height: 1.45;
  color: var(--color-text-secondary);
  min-width: 0;
}

.tcat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
}
/* Mono accent code-chip — mirrors MemoryCommandsHero's .mc-cmd so each tool
   name reads as a token to drop into the YAML `tools:` array. */
.tcat-chip {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 1px var(--mk-space-6);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  font-weight: 500;
  line-height: 1.6;
  white-space: nowrap;
}

/* Stack the description under the name on narrow screens so chips stay legible. */
@media (max-width: 560px) {
  .tcat-desc {
    flex-basis: 100%;
    padding-left: var(--mk-space-18);
  }
}
</style>
