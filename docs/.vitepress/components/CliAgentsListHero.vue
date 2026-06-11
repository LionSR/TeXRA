<script setup>
// Terminal card for `texra agents list` — built-in-agents.md. The same catalog
// the GUI agent picker shows, enumerated from a terminal in the real text
// format: one `<category>\t<name>\t<description>` row per visible agent
// (packages/cli/src/runtime/agents.ts formatCliAgentList; the guide documents
// the column order). Names and categories match the bundled agent YAMLs under
// packages/extension/resources/; descriptions are abridged from them for card
// width (the real command prints them in full).
//
// Built on <TermWindow>; .mockup-scoped and token-only, so it flips with the
// docs theme. A believable static slice of the catalog, not the full roster.
const rows = [
  {
    category: 'workflow',
    name: 'polish',
    description:
      'Rewrites and restructures text to improve clarity, flow, and readability.',
  },
  {
    category: 'workflow',
    name: 'correct',
    description:
      'Fixes typos, grammar, and LaTeX formatting without changing your style.',
  },
  {
    category: 'workflow',
    name: 'merge',
    description: 'Merges partial edits back into the full original document.',
  },
  {
    category: 'toolUse',
    name: 'assistant',
    description:
      'General-purpose scientific assistant covering the full research workflow.',
  },
  {
    category: 'toolUse',
    name: 'research',
    description:
      'Research assistant for analytical derivations and numerical programming.',
  },
  {
    category: 'toolUse',
    name: 'lean',
    description:
      'Lean 4 proof assistant with VS Code integration and CLI fallback.',
  },
];
</script>

<template>
  <TermWindow title="texra agents list" aria-label="texra agents list output">
    <div class="cal-scroll">
      <div class="mk-term-prompt cal-prompt">
        <span class="mk-term-sigil">$</span>
        <span class="mk-term-cmd">texra agents list</span>
      </div>
      <div v-for="r in rows" :key="r.name" class="cal-row">
        <span class="cal-cat">{{ r.category }}</span>
        <span class="cal-name">{{ r.name }}</span>
        <span class="cal-desc">{{ r.description }}</span>
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes. Column-aligned output scrolls horizontally instead of reflowing. */
.cal-scroll {
  overflow-x: auto;
  font-size: var(--mk-fs-76);
}
.cal-prompt {
  margin-bottom: var(--mk-space-8);
}
.cal-row {
  display: grid;
  grid-template-columns: 0.5fr 0.6fr 3fr;
  min-width: var(--mk-size-470);
  gap: var(--mk-space-10);
  padding: var(--mk-space-3) 0;
  align-items: baseline;
}
.cal-cat {
  color: var(--mk-syn-keyword);
}
.cal-name {
  color: var(--mk-syn-fn);
  font-weight: 600;
}
.cal-desc {
  color: var(--mk-text-faint);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
