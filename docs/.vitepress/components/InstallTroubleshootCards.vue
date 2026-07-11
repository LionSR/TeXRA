<script setup>
// Frameless symptom→fix grid for guide/installation.md's "Common Installation
// Issues" list. The source prose was a nested numbered/bulleted list of four
// failure categories, each with two or three diagnostic checks — exactly the
// scan-not-read shape a reader hits when something is broken. Rendering it as a
// card per symptom (mono title + a leading status pill + check rows) lets the
// reader jump straight to their failure mode instead of parsing nesting.
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, so the
// `--mk-*` colour + dimensional tokens resolve here and the cards flip cleanly
// between the docs light / dark themes. The .todos / .todo / .td-* row vocab is
// owned by theme/mockup.css (same as QaChecklistCard), reinforcing familiarity.
import MockCard from './MockCard.vue';
import StatusPill from './StatusPill.vue';

// Mirrors the page's troubleshooting list verbatim; one card per symptom.
const issues = [
  {
    icon: 'plug',
    title: 'Extension not loading',
    checks: [
      'VS Code is on 1.125 or newer',
      'Output panel → "TeXRA" shows no errors',
      'Reinstall the extension',
    ],
  },
  {
    icon: 'file-code',
    title: 'LaTeX processing errors',
    checks: [
      'LaTeX is on your system PATH',
      'latexmk --version (or pdflatex) runs',
      'Required LaTeX packages are installed',
    ],
  },
  {
    icon: 'image',
    title: 'Image processing errors',
    checks: [
      'GraphicsMagick / ImageMagick installed',
      'Ghostscript installed and accessible',
      'PATH environment variables are set',
    ],
  },
  {
    icon: 'key',
    title: 'API key issues',
    checks: [
      'Keys are entered correctly',
      'You are within provider usage limits',
      'Network allows the API endpoints',
    ],
  },
];
</script>

<template>
  <div class="mockup its-grid" role="group">
    <MockCard
      v-for="(it, i) in issues"
      :key="i"
      :title="it.title"
      :icon="it.icon"
    >
      <template #head>
        <StatusPill class="its-tag" variant="warning" shape="pill"
          >check these</StatusPill
        >
      </template>
      <div class="todos its-todos">
        <div v-for="(c, j) in it.checks" :key="j" class="todo">
          <wa-icon class="td-ic" library="texra" name="check"></wa-icon>
          <span class="td-tx">{{ c }}</span>
        </div>
      </div>
    </MockCard>
  </div>
</template>

<style scoped>
.its-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
@media (max-width: 640px) {
  .its-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.its-todos {
  margin-top: var(--mk-space-4);
}
.its-tag {
  margin-left: auto;
}
</style>
