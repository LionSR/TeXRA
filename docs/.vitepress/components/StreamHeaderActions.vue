<script setup>
// Frameless StreamHeader figure for the ProgressBoard guide. Lifts the
// header strip out of the VS Code window chrome and shows it on its own:
// the stream identity (name + live status dot + token/cost summary) above
// the full action toolbar, with every icon labeled so the icon↔action
// mapping the prose enumerates is explicit at a glance.
//
// Reuses the proven .stream-head / .sh-name / .sh-dot / .sh-badge primitives
// from theme/mockup.css (shared with GuideIntroHero + CompareHero) and the
// .iact icon-button style (shared with QuickStartHero's header actions).
// Root carries `.mockup`, so every --mk-* token + the wa-* bridge resolves
// and the figure flips with the docs light/dark theme.
const actions = [
  { icon: 'debug-stop', label: 'Stop', desc: 'Abort the running task' },
  { icon: 'debug-rerun', label: 'Run Again', desc: 'Re-run, same config' },
  { icon: 'reply', label: 'Restore', desc: 'Load config into Launcher' },
  { icon: 'diff-multiple', label: 'Diff', desc: 'latexdiff vs. base' },
  { icon: 'check', label: 'Accept', desc: 'Replace base with edit' },
  { icon: 'folder-opened', label: 'Open', desc: 'Reveal task storage' },
  { icon: 'archive', label: 'Pack', desc: 'Archive to History' },
  { icon: 'trash', label: 'Clean', desc: 'Delete task storage' },
  { icon: 'clear-all', label: 'Erase', desc: 'Remove stream + log' },
];
</script>

<template>
  <div class="mockup sha" role="group" aria-label="Stream header actions">
    <!-- Identity strip: name + live status dot + token/cost summary -->
    <div class="stream-head">
      <span class="sh-name">polish@sonnet46: paper.tex</span>
      <span class="sh-dot" title="Running"></span>
      <span class="sh-badge">
        <wa-icon class="sh-pulse" library="texra" name="pulse"></wa-icon>
        r0–r2 · 48.2K in / 6.1K out · $0.21
      </span>
    </div>

    <!-- Labeled action toolbar — one icon button per header action -->
    <div class="sha-bar">
      <div v-for="a in actions" :key="a.label" class="sha-act">
        <span class="iact" :title="a.desc">
          <wa-icon library="texra" :name="a.icon"></wa-icon>
        </span>
        <span class="sha-label">{{ a.label }}</span>
        <span class="sha-desc">{{ a.desc }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Frameless card shell — mirrors MockupPanel's bordered surface, no chrome. */
.sha {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}
/* The identity strip reuses .stream-head from mockup.css; only let the
   token/cost badge keep its full label rather than truncating. */
.sha .stream-head {
  flex-wrap: wrap;
}
.sha .sh-badge {
  white-space: nowrap;
}

/* Labeled toolbar: each action is its icon button + label + tooltip text,
   so the icon↔action mapping is explicit without hover. */
.sha-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--mk-size-120), 1fr));
  gap: var(--mk-space-4);
  padding: var(--mk-space-12) var(--mk-space-12) var(--mk-space-14);
}
.sha-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--mk-space-3);
  padding: var(--mk-space-7) var(--mk-space-4);
  border-radius: var(--mk-radius-md);
}
.sha-act .iact {
  color: var(--color-text-secondary);
}
.sha-label {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.sha-desc {
  font-size: var(--mk-fs-66);
  line-height: 1.3;
  color: var(--mk-text-faint);
}
</style>
