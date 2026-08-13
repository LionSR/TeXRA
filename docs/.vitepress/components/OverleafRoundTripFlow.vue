<script setup>
// Frameless round-trip pipeline for the Overleaf ⇄ TeXRA git workflow
// (guide/working-with-overleaf.md → "Workflow Steps"). Two endpoint nodes —
// Overleaf (collaboration / browser) on the left, VS Code + TeXRA (local
// editing) on the right — bracket four labelled stage chips: Clone, Edit,
// Commit, Sync. A rightward "git clone / pull" arrow pulls work down to local;
// a leftward "git push" arrow sends it back, making the loop explicit at a
// glance. Standalone (no MockupFrame) — the root carries `.mockup` so the
// shared `--mk-*` colour + dimensional tokens resolve and the card flips with
// the docs light / dark theme.
const stages = [
  { icon: 'repo-clone', label: 'Clone', sub: 'pull project down' },
  { icon: 'sparkle', label: 'Edit', sub: 'TeXRA agents' },
  { icon: 'git-commit', label: 'Commit', sub: 'granular history' },
  { icon: 'arrow-right', label: 'Sync', sub: 'push back up' },
];
</script>

<template>
  <div
    class="mockup ort"
    role="group"
    aria-label="Overleaf to TeXRA round-trip workflow"
  >
    <!-- Endpoints + directional arrows -->
    <div class="ort-bridge">
      <div class="ort-node">
        <wa-icon class="ort-node-ic" library="texra" name="globe"></wa-icon>
        <span class="ort-node-name">Overleaf</span>
        <span class="ort-node-sub">collaboration · browser</span>
      </div>

      <div class="ort-pipe" aria-hidden="true">
        <span class="ort-dir ort-dir-down">
          <wa-icon
            class="ort-dir-ic"
            library="texra"
            name="cloud-download"
          ></wa-icon>
          git clone / pull
          <wa-icon
            class="ort-dir-arrow"
            library="texra"
            name="arrow-right"
          ></wa-icon>
        </span>
        <span class="ort-dir ort-dir-up">
          <wa-icon
            class="ort-dir-arrow"
            library="texra"
            name="arrow-left"
          ></wa-icon>
          git push
          <wa-icon
            class="ort-dir-ic"
            library="texra"
            name="cloud-upload"
          ></wa-icon>
        </span>
      </div>

      <div class="ort-node ort-node-local">
        <wa-icon
          class="ort-node-ic"
          library="texra"
          name="code-branch"
        ></wa-icon>
        <span class="ort-node-name">VS Code + TeXRA</span>
        <span class="ort-node-sub">local AI editing</span>
      </div>
    </div>

    <!-- Four-stage local loop -->
    <div class="ort-stages">
      <template v-for="(s, i) in stages" :key="s.label">
        <div class="ort-stage">
          <span class="ort-stage-n">{{ i + 1 }}</span>
          <wa-icon
            class="ort-stage-ic"
            library="texra"
            :name="s.icon"
          ></wa-icon>
          <span class="ort-stage-label">{{ s.label }}</span>
          <span class="ort-stage-sub">{{ s.sub }}</span>
        </div>
        <wa-icon
          v-if="i < stages.length - 1"
          class="ort-stage-arrow"
          library="texra"
          name="arrow-right"
          aria-hidden="true"
        ></wa-icon>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. Tokens come from `.mockup` (theme/mockup.css). */
.ort {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) auto;
  padding: var(--mk-space-14);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

/* Endpoints + the two git directions ------------------------------ */
.ort-bridge {
  display: flex;
  align-items: stretch;
  gap: var(--mk-space-8);
}

.ort-node {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--mk-space-3);
  width: var(--mk-size-120);
  padding: var(--mk-space-10) var(--mk-space-9);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-md);
  text-align: center;
}
.ort-node-local {
  border-color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
}
.ort-node-ic {
  font-size: var(--mk-space-20);
  color: var(--mk-accent);
}
.ort-node-name {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.ort-node-sub {
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
}

.ort-pipe {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--mk-space-6);
}
.ort-dir {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-5) var(--mk-space-8);
  border-radius: var(--mk-radius-pill);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  white-space: nowrap;
}
.ort-dir-down {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
}
.ort-dir-up {
  color: var(--mk-syn-fn);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
}
.ort-dir-ic,
.ort-dir-arrow {
  font-size: var(--mk-fs-72);
  flex-shrink: 0;
}

/* Four-stage local loop ------------------------------------------- */
.ort-stages {
  display: flex;
  align-items: stretch;
  gap: var(--mk-space-6);
}
.ort-stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--mk-space-2);
  padding: var(--mk-space-8) var(--mk-space-9);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
}
.ort-stage-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  color: var(--mk-accent);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-68);
  font-weight: 700;
}
.ort-stage-ic {
  font-size: var(--mk-fs-82);
  color: var(--mk-accent);
}
.ort-stage-label {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.ort-stage-sub {
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
}
.ort-stage-arrow {
  align-self: center;
  flex-shrink: 0;
  font-size: var(--mk-fs-78);
  color: var(--mk-text-faint);
}

@media (max-width: 640px) {
  .ort-bridge,
  .ort-stages {
    flex-direction: column;
  }
  .ort-node {
    width: auto;
  }
  .ort-dir {
    white-space: normal;
  }
  .ort-stage-arrow {
    transform: rotate(90deg);
  }
}
</style>
