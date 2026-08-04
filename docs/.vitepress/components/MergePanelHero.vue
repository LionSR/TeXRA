<script setup>
// Frameless variant of LatexDiffHero's left sidebar — the LaTeXDiffs section on
// its own, with the editor / PDF pane dropped so the merge controls read
// clearly. Mirrors the Merge Workflow: pick a Base File, pick an Edited File,
// then click Merge in the Edited row (the merge icon is highlighted here as the
// act-on control). The merge runs on the configured helper model.
//
// Root carries `.mockup`, so the shared `--mk-*` tokens and the .field/.frow/
// .select/.acts/.act vocabulary in theme/mockup.css resolve here and flip with
// the docs light / dark theme.
</script>

<template>
  <div
    class="mockup merge-panel"
    role="group"
    aria-label="LaTeXDiffs merge controls"
  >
    <div class="diffui">
      <div class="sechead">
        <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
        <wa-icon class="sec-ic" library="texra" name="source-control"></wa-icon>
        <span class="sec-lbl">LaTeXDiffs</span>
      </div>

      <!-- Step 1 · Base File -->
      <div class="field">
        <div class="frow">
          <span class="f-label"
            ><wa-icon class="lbl-ic" library="texra" name="file"></wa-icon>
            Base</span
          >
          <span class="step-n">1</span>
        </div>
        <div class="select">
          <span class="s-val">spectral-gap.tex</span>
          <wa-icon
            class="s-caret"
            library="texra"
            name="chevron-down"
          ></wa-icon>
        </div>
      </div>

      <!-- Step 2 · Edited File + Step 3 · Merge action (highlighted) -->
      <div class="field">
        <div class="frow">
          <span class="f-label"
            ><wa-icon class="lbl-ic" library="texra" name="edit"></wa-icon>
            Edited</span
          >
          <div class="acts">
            <span class="act" title="Accept changes"
              ><wa-icon library="texra" name="check"></wa-icon
            ></span>
            <span class="act" title="Compare files"
              ><wa-icon library="texra" name="diff"></wa-icon
            ></span>
            <span class="act act-on" title="Merge edits"
              ><wa-icon library="texra" name="merge"></wa-icon
            ></span>
            <span class="act" title="LaTeXdiff"
              ><wa-icon library="texra" name="diff-single"></wa-icon
            ></span>
          </div>
          <span class="step-n">2</span>
        </div>
        <div class="select">
          <span class="s-val">r1/spectral-gap.tex</span>
          <wa-icon
            class="s-caret"
            library="texra"
            name="chevron-down"
          ></wa-icon>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. Tokens + .field/.frow/.select/.acts/.act come from `.mockup`
   (theme/mockup.css). */
.merge-panel {
  max-width: var(--mk-size-320);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) 0;
  overflow: hidden;
}
.diffui {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-12);
  padding: var(--mk-space-12);
  font-family: var(--vp-font-family-base);
}
.sec-ic {
  display: inline-flex;
  color: var(--mk-accent);
  font-size: var(--mk-space-13);
}
/* Small numbered step marker pinned to each row's far right. */
.step-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  flex-shrink: 0;
  border-radius: var(--mk-radius-pill);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  color: var(--mk-accent);
  font-size: var(--mk-fs-70);
  font-weight: 700;
  font-family: var(--vp-font-family-base);
}
</style>
