<script setup>
// Frameless two-column split for guide/desktop-migration.md. The page draws the
// key distinction twice in prose — "What Carries Over" vs "What To Reconfigure"
// — as two flat bullet lists the reader has to hold side by side in their head.
// Rendering them as a literal side-by-side comparison makes the boundary the
// figure itself: anything that lives in the project folder or on the machine
// follows you (green, no action); anything the extension host stored privately
// must be set again in the desktop app (amber, reconfigure).
//
// Card shell + inline mono header come by COMPOSITION from <MockCard>, and the
// header state badge from <StatusPill>, so the `--mk-*` colour + dimensional
// tokens resolve here and the split flips cleanly between the docs light / dark
// themes. Each row carries its own category glyph rather than a uniform check,
// so the figure stays scannable as a map of what moves where.
import MockCard from './MockCard.vue';
import StatusPill from './StatusPill.vue';

// Carries over because it lives outside the VS Code extension host.
const carries = [
  { icon: 'file-lines', text: 'Manuscript source & repository history' },
  { icon: 'file-code', text: 'Workspace .env files, if you keep keys there' },
  {
    icon: 'screwdriver-wrench',
    text: 'System tools — LaTeX, Perl, Git, Ghostscript',
  },
  { icon: 'robot', text: 'Project-local custom agent YAML' },
  { icon: 'users', text: 'Committed team config (.latexindent.yaml, …)' },
];

// Stored privately by the extension host — re-enter it in the desktop app.
const reconfigure = [
  { icon: 'key', text: 'Provider API keys — Models tab' },
  { icon: 'right-to-bracket', text: 'TeXRA / remote-agent sign-in' },
  { icon: 'code-branch', text: 'GitHub token for PR & issue tools' },
  { icon: 'gear', text: 'Agent visibility, model list, tool approvals' },
  { icon: 'wrench', text: 'LaTeX settings stored only in VS Code' },
  { icon: 'clock-rotate-left', text: 'Execution history & task archives' },
];
</script>

<template>
  <div
    class="mockup dm-split"
    role="group"
    aria-label="Desktop migration: what carries over vs what to reconfigure"
  >
    <MockCard class="dm-keep" icon="check-double" title="Carries over">
      <template #head>
        <StatusPill class="dm-tag" variant="success" shape="pill"
          >no action</StatusPill
        >
      </template>
      <div class="dm-rows">
        <div v-for="(r, i) in carries" :key="i" class="dm-row">
          <wa-icon class="dm-ic" library="texra" :name="r.icon"></wa-icon>
          <span class="dm-tx">{{ r.text }}</span>
        </div>
      </div>
    </MockCard>

    <MockCard class="dm-redo" icon="arrows-rotate" title="Reconfigure">
      <template #head>
        <StatusPill class="dm-tag" variant="warning" shape="pill"
          >set again</StatusPill
        >
      </template>
      <div class="dm-rows">
        <div v-for="(r, i) in reconfigure" :key="i" class="dm-row">
          <wa-icon class="dm-ic" library="texra" :name="r.icon"></wa-icon>
          <span class="dm-tx">{{ r.text }}</span>
        </div>
      </div>
    </MockCard>
  </div>
</template>

<style scoped>
.dm-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
@media (max-width: 640px) {
  .dm-split {
    grid-template-columns: minmax(0, 1fr);
  }
}
.dm-tag {
  margin-left: auto;
}
.dm-rows {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
  margin-top: var(--mk-space-4);
}
.dm-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-2) 0;
}
.dm-ic {
  display: inline-flex;
  flex-shrink: 0;
  font-size: var(--mk-space-12);
}
/* Two-tone leading glyphs: green = follows you, amber = set it again. */
.dm-keep .dm-ic {
  color: var(--color-success);
}
.dm-redo .dm-ic {
  color: var(--color-warning);
}
.dm-tx {
  color: var(--mk-text-dim);
  min-width: 0;
}
</style>
