<script setup>
// Frameless command-palette / quick-input strip for the recommended Overleaf
// clone flow (guide/working-with-overleaf.md → "TeXRA: Clone Overleaf
// Project"). Three stacked stages mirror what the user actually sees:
//   1. the command palette with the command highlighted,
//   2. the quick-input asking for the project URL / 24-char ID,
//   3. the quick-input asking for the olp_ Git token (masked), with a
//      "Saved to VS Code secret storage" footnote.
// A numbered 1-2-3 gutter + down-chevrons connect the stages. Standalone
// (no MockupFrame) — the root carries `.mockup` so the shared `--mk-*`
// colour + dimensional tokens resolve and the card flips with the docs
// light / dark theme.
</script>

<template>
  <div
    class="mockup oc-flow"
    role="group"
    aria-label="Clone Overleaf project command flow"
  >
    <!-- Stage 1 — command palette -->
    <div class="oc-stage">
      <span class="oc-num">1</span>
      <div class="oc-panel">
        <div class="oc-palette">
          <span class="oc-prompt">&gt;</span>
          <wa-icon class="oc-magnify" library="texra" name="search"></wa-icon>
          <span class="oc-palette-text">TeXRA: Clone Overleaf Project</span>
        </div>
        <div class="oc-pal-item">
          <wa-icon
            class="oc-item-ic"
            library="texra"
            name="repo-clone"
          ></wa-icon>
          <span class="oc-item-name">TeXRA: Clone Overleaf Project</span>
          <span class="oc-item-cat">TeXRA</span>
        </div>
      </div>
    </div>

    <wa-icon class="oc-chev" library="texra" name="chevron-down"></wa-icon>

    <!-- Stage 2 — project URL / ID -->
    <div class="oc-stage">
      <span class="oc-num">2</span>
      <div class="oc-panel">
        <div class="oc-input">
          <span class="oc-val"
            >https://www.overleaf.com/project/64f8a2c1d3e5b6f7a9c0b1d2</span
          >
          <wa-icon class="oc-enter" library="texra" name="reply"></wa-icon>
        </div>
        <div class="oc-place">
          Paste Overleaf project URL or 24-character project ID
        </div>
      </div>
    </div>

    <wa-icon class="oc-chev" library="texra" name="chevron-down"></wa-icon>

    <!-- Stage 3 — olp_ Git token (masked) -->
    <div class="oc-stage">
      <span class="oc-num">3</span>
      <div class="oc-panel">
        <div class="oc-input">
          <span class="oc-val oc-mask">olp_••••••••••••••••••••</span>
          <wa-icon class="oc-enter" library="texra" name="reply"></wa-icon>
        </div>
        <div class="oc-place">
          Overleaf Git token (olp_…)
          <span class="oc-tag">
            <wa-icon class="oc-tag-ic" library="texra" name="shield"></wa-icon>
            Saved to VS Code secret storage
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. Tokens come from `.mockup` (theme/mockup.css). */
.oc-flow {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  max-width: var(--mk-size-520);
  margin: var(--mk-space-12) auto;
  padding: var(--mk-space-14);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

.oc-stage {
  display: flex;
  align-items: flex-start;
  gap: var(--mk-space-9);
}

.oc-num {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-space-18);
  height: var(--mk-space-18);
  margin-top: var(--mk-space-4);
  border-radius: 50%;
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  color: var(--mk-accent);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  font-weight: 700;
}

.oc-panel {
  flex: 1;
  min-width: 0;
}

/* Command palette ------------------------------------------------ */
.oc-palette {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-7) var(--mk-space-9);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-md) var(--mk-radius-md) 0 0;
}
.oc-prompt {
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  flex-shrink: 0;
}
.oc-magnify {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-74);
  flex-shrink: 0;
}
.oc-palette-text {
  color: var(--mk-text);
  font-size: var(--mk-fs-76);
}

.oc-pal-item {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-7) var(--mk-space-9);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid var(--mk-border);
  border-top: none;
  border-radius: 0 0 var(--mk-radius-md) var(--mk-radius-md);
}
.oc-item-ic {
  color: var(--mk-syn-fn);
  font-size: var(--mk-fs-76);
  flex-shrink: 0;
}
.oc-item-name {
  color: var(--mk-text);
  font-size: var(--mk-fs-74);
  font-weight: 600;
  flex: 1;
  min-width: 0;
}
.oc-item-cat {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
  flex-shrink: 0;
}

/* Quick-input boxes ---------------------------------------------- */
.oc-input {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-8) var(--mk-space-9);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-accent);
  border-radius: var(--mk-radius-md);
}
.oc-val {
  flex: 1;
  min-width: 0;
  color: var(--mk-text);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oc-mask {
  letter-spacing: 0.05em;
}
.oc-enter {
  flex-shrink: 0;
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}

.oc-place {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-4);
  padding-left: var(--mk-space-2);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
}

.oc-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  padding: 0 var(--mk-space-6);
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-68);
  font-weight: 600;
}
.oc-tag-ic {
  font-size: var(--mk-fs-68);
}

/* Connector chevrons --------------------------------------------- */
.oc-chev {
  align-self: flex-start;
  margin-left: var(--mk-space-7);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-74);
}
</style>
