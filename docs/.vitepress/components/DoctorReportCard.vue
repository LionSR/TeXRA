<script setup>
// Frameless `texra doctor` report. Mirrors the CLI's environment check: a
// monospace command line followed by grouped status rows. Status vocabulary
// matches ApiKeysHero — `found` (green circle-check) / `on-demand`
// (neutral, "checked when needed") / `missing` (amber). No VS Code window
// chrome; the root carries `.mockup` so it inherits the --mk-* token block and
// flips with the docs light/dark theme.
const groups = [
  {
    label: 'LaTeX toolchain',
    rows: [
      { name: 'latexmk', status: 'found' },
      { name: 'pdflatex', status: 'found' },
      { name: 'xelatex', status: 'found' },
      { name: 'lualatex', status: 'found' },
      { name: 'bibtex', status: 'found' },
      { name: 'biber', status: 'found' },
      { name: 'latexdiff', status: 'found' },
      { name: 'latexindent', status: 'found' },
    ],
  },
  {
    label: 'Runtime & auth',
    rows: [
      { name: 'Node.js', status: 'found', detail: '22.11.0' },
      { name: 'Authentication', status: 'found', detail: 'signed in' },
      {
        name: 'Models available',
        status: 'found',
        detail: 'Anthropic, OpenAI',
      },
    ],
  },
  {
    label: 'Optional · checked on demand',
    rows: [
      { name: 'GraphicsMagick / ImageMagick', status: 'on-demand' },
      { name: 'Ghostscript', status: 'on-demand' },
      { name: 'Wolfram', status: 'on-demand' },
    ],
  },
];
</script>

<template>
  <div class="mockup doctor" role="group" aria-label="texra doctor report">
    <div class="dr-cmd"><span class="dr-prompt">$</span> texra doctor</div>

    <div v-for="group in groups" :key="group.label" class="dr-group">
      <div class="dr-group-label">{{ group.label }}</div>
      <ul class="dr-rows">
        <li v-for="row in group.rows" :key="row.name" class="dr-row">
          <span class="dr-icon" :class="`dr-icon--${row.status}`">
            <wa-icon
              v-if="row.status === 'found'"
              library="texra"
              name="circle-check"
            ></wa-icon>
            <wa-icon
              v-else-if="row.status === 'on-demand'"
              library="texra"
              name="circle-info"
            ></wa-icon>
            <wa-icon
              v-else
              library="texra"
              name="triangle-exclamation"
            ></wa-icon>
          </span>
          <span class="dr-name">{{ row.name }}</span>
          <span v-if="row.detail" class="dr-detail">{{ row.detail }}</span>
          <span class="dr-status" :class="`dr-status--${row.status}`">
            <template v-if="row.status === 'found'">found</template>
            <template v-else-if="row.status === 'on-demand'"
              >checked when needed</template
            >
            <template v-else>not found</template>
          </span>
        </li>
      </ul>
    </div>

    <div class="dr-foot">
      <span class="dr-foot-ok">✓ Core dependencies ready</span>
    </div>
  </div>
</template>

<style scoped>
/* All tokens resolve from `.mockup` (theme/mockup.css). No raw hex / px. */
.doctor {
  background: var(--mk-bg-deep);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  padding: var(--mk-space-16) var(--mk-space-18);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-82);
  line-height: 1.6;
  color: var(--wa-color-text-normal);
}

.dr-cmd {
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.dr-prompt {
  color: var(--mk-syn-fn);
  margin-right: var(--mk-space-6);
}

.dr-group {
  margin-top: var(--mk-space-14);
}
.dr-group-label {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  padding-bottom: var(--mk-space-5);
  border-bottom: 1px solid var(--color-border);
}

.dr-rows {
  list-style: none;
  margin: var(--mk-space-6) 0 0;
  padding: 0;
}
.dr-row {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  padding: var(--mk-space-2) 0;
}

.dr-icon {
  flex-shrink: 0;
  align-self: center;
  display: inline-flex;
  font-size: var(--mk-space-13);
}
.dr-icon--found {
  color: var(--color-success);
}
.dr-icon--on-demand {
  color: var(--wa-color-icon-info);
}
.dr-icon--missing {
  color: var(--color-warning);
}

.dr-name {
  color: var(--wa-color-text-normal);
}
.dr-detail {
  color: var(--color-text-secondary);
}

.dr-status {
  margin-left: auto;
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  white-space: nowrap;
}
.dr-status--found {
  color: var(--color-success);
}
.dr-status--on-demand {
  color: var(--color-text-tertiary);
}
.dr-status--missing {
  color: var(--color-warning);
}

.dr-foot {
  margin-top: var(--mk-space-16);
  padding-top: var(--mk-space-12);
  border-top: 1px solid var(--color-border);
}
.dr-foot-ok {
  color: var(--mk-ins-text);
  font-weight: 600;
}
</style>
