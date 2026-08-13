<script setup>
// Frameless progress-view toolbar for one finished workflow run. Mirrors the
// four run-folder actions the configuration.md "Agent Output Storage" prose
// enumerates: Accept (copy the revised file into the workspace via the
// approval flow), Pack (snapshot the run into History/), Open in task storage
// (reveal executions/{id}/), and Clean (discard the run folder — destructive).
// A run label + the r{round}/output.ext path anchor the executions/{id}/ layout
// the surrounding prose describes. Reuses ApiKeysHero/MemoryHero toolbar-button
// styling (.key-btn + the destructive --rm hover) and the frameless `.mockup`
// shell so it inherits the --mk-* tokens and flips with the docs theme.
const actions = [
  { icon: 'check', label: 'Accept', hint: 'Copy revised file into workspace' },
  { icon: 'archive', label: 'Pack', hint: 'Snapshot run to History/' },
  {
    icon: 'folder-open',
    label: 'Open in task storage',
    hint: 'Reveal executions/{id}/',
  },
  { icon: 'trash', label: 'Clean', hint: 'Discard the run folder', rm: true },
];
</script>

<template>
  <div class="mockup aotc" role="group" aria-label="Run output toolbar">
    <div class="aotc-row">
      <div class="aotc-run">
        <wa-icon class="aotc-run-ic" library="texra" name="file-code"></wa-icon>
        <span class="aotc-run-text">
          <span class="aotc-run-name">r0/output.tex</span>
          <span class="aotc-run-path">executions/a1b2c3/</span>
        </span>
      </div>
      <div class="aotc-acts">
        <span
          v-for="a in actions"
          :key="a.label"
          class="aotc-btn"
          :class="{ 'aotc-btn--rm': a.rm }"
          :title="a.hint"
        >
          <wa-icon library="texra" :name="a.icon"></wa-icon>
          <span class="aotc-btn-lbl">{{ a.label }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* All tokens resolve from `.mockup` (theme/mockup.css). No raw hex / px. */
.aotc {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  max-width: var(--mk-size-470);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

.aotc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--mk-space-12);
  padding: var(--mk-space-10) var(--mk-space-14);
  background: var(--mk-bg-soft);
}

.aotc-run {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  min-width: 0;
}
.aotc-run-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.aotc-run-text {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  min-width: 0;
}
.aotc-run-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}
.aotc-run-path {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}

.aotc-acts {
  display: flex;
  align-items: center;
  gap: var(--mk-space-4);
}
.aotc-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  padding: var(--mk-space-5) var(--mk-space-8);
  border-radius: var(--mk-radius);
  color: var(--color-text-secondary);
  font-size: var(--mk-fs-74);
  cursor: pointer;
}
.aotc-btn wa-icon {
  font-size: var(--mk-space-13);
}
.aotc-btn:hover {
  background: var(--mk-hover-bg);
  color: var(--wa-color-text-normal);
}
.aotc-btn--rm {
  color: var(--mk-del-text);
}
.aotc-btn--rm:hover {
  background: color-mix(in srgb, var(--color-error) 12%, transparent);
  color: var(--color-error);
}
.aotc-btn-lbl {
  font-weight: 500;
}
</style>
