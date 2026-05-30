<script setup>
// Frameless icon → action legend for the local-editing step of the Overleaf
// round-trip (guide/working-with-overleaf.md → "2. Edit Locally with TeXRA in
// VS Code"). The page's bullet list pairs each editing action with its toolbar
// glyph (play / diff-single / merge / wand / tools / source-control); a flat
// prose list buries those icon associations, so this maps them one-to-one as a
// scannable legend. Standalone — the root carries `.mockup` so the shared
// `--mk-*` colour + dimensional tokens resolve and the card flips with the docs
// light / dark theme. Icon names are all real entries in the `texra` library
// (theme/webAwesomeIcons.js), matching the glyphs the prose references.
const actions = [
  {
    icon: 'files',
    label: 'Select files, agent, model',
    hint: 'Pick what to edit and which model runs',
  },
  {
    icon: 'pencil',
    label: 'Write instructions',
    hint: 'Describe the change in plain language',
  },
  {
    icon: 'play',
    label: 'Execute',
    hint: 'Run the agent on your selection',
    accent: true,
  },
  {
    icon: 'eye',
    label: 'Review outputs',
    hint: 'Inspect r0/output.tex from task storage',
  },
  {
    icon: 'diff-single',
    label: 'latexdiff / merge',
    hint: 'Compare or fold edits with code-compare & merge',
  },
  {
    icon: 'wand',
    label: 'Auto-extract & tools',
    hint: 'Pull figures and toggle tool options',
  },
];
</script>

<template>
  <div
    class="mockup oea"
    role="group"
    aria-label="TeXRA in-editor editing actions"
  >
    <div class="oea-head">
      <wa-icon
        class="oea-head-ic"
        library="texra"
        name="source-control"
      ></wa-icon>
      <span class="oea-head-text">Edit locally in VS Code</span>
    </div>
    <ul class="oea-list">
      <li v-for="a in actions" :key="a.label" class="oea-row">
        <span class="oea-ic" :class="{ 'oea-ic--accent': a.accent }">
          <wa-icon library="texra" :name="a.icon"></wa-icon>
        </span>
        <span class="oea-text">
          <span class="oea-label">{{ a.label }}</span>
          <span class="oea-hint">{{ a.hint }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* All tokens resolve from `.mockup` (theme/mockup.css). No raw hex / px. */
.oea {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-12) auto;
  max-width: var(--mk-size-470);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

.oea-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-9) var(--mk-space-14);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border-soft);
}
.oea-head-ic {
  color: var(--mk-accent);
  font-size: var(--mk-fs-76);
  flex-shrink: 0;
}
.oea-head-text {
  color: var(--mk-text);
  font-size: var(--mk-fs-76);
  font-weight: 600;
}

.oea-list {
  list-style: none;
  margin: 0;
  padding: var(--mk-space-8) var(--mk-space-10);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}

.oea-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-9);
  padding: var(--mk-space-6) var(--mk-space-7);
  border-radius: var(--mk-radius-md);
}
.oea-row:hover {
  background: var(--mk-bg-raised);
}

.oea-ic {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-space-20);
  height: var(--mk-space-20);
  border-radius: var(--mk-radius);
  background: var(--mk-bg-raised);
  color: var(--mk-syn-fn);
  font-size: var(--mk-fs-74);
}
.oea-ic--accent {
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  color: var(--mk-accent);
}

.oea-text {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  min-width: 0;
}
.oea-label {
  color: var(--mk-text);
  font-size: var(--mk-fs-74);
  font-weight: 600;
}
.oea-hint {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
}
</style>
