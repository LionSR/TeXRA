<script setup>
// Review-results product slice: the VS Code diff editor TeXRA opens after a
// run — the original input on the left, the round-0 output (r0/draft.tex) on
// the right, with removed text struck in red and improved text added in green.
// Mirrors the "ProgressBoard Diff" compare view from the Quick Start walkthrough.
import MockupFrame from './MockupFrame.vue';
</script>

<template>
  <MockupFrame title="draft.tex ↔ r0/draft.tex (Working Tree) — texra-sample">
    <div class="result diff">
      <div class="tabs">
        <button type="button" class="tab active">
          <wa-icon class="t-ic" library="texra" name="diff-multiple"></wa-icon
          >draft.tex (r0) — Compare
        </button>
      </div>

      <div class="diff-body">
        <!-- Original -->
        <div class="pane">
          <div class="pane-head">
            <wa-icon
              class="ph-ic t-tex"
              library="texra"
              name="file-code"
            ></wa-icon>
            draft.tex
            <span class="ph-tag">Original</span>
          </div>
          <div class="diff-surface">
            <div class="dl">
              <span class="gut">12</span
              ><span class="kw">\begin</span>{abstract}
            </div>
            <div class="dl chg">
              <span class="gut">13</span>We present a
              <del>novel and efficient</del> method for the
            </div>
            <div class="dl chg">
              <span class="gut">14</span>estimation of spectral gaps
              <del>in random regular graphs</del>.
            </div>
            <div class="dl">
              <span class="gut">15</span><span class="kw">\end</span>{abstract}
            </div>
            <div class="dl"><span class="gut">16</span></div>
            <div class="dl">
              <span class="gut">17</span
              ><span class="kw">\section</span>{Preliminaries}
            </div>
            <div class="dl chg">
              <span class="gut">18</span>Let <span class="m">$G$</span> be a
              graph<del>.</del>
            </div>
          </div>
        </div>

        <!-- Revised -->
        <div class="pane">
          <div class="pane-head">
            <wa-icon
              class="ph-ic t-tex"
              library="texra"
              name="file-code"
            ></wa-icon>
            r0/draft.tex
            <span class="ph-tag ph-tag--new">TeXRA</span>
          </div>
          <div class="diff-surface">
            <div class="dl">
              <span class="gut">12</span
              ><span class="kw">\begin</span>{abstract}
            </div>
            <div class="dl add">
              <span class="gut">13</span>We present an
              <ins>efficient</ins> method for the
            </div>
            <div class="dl add">
              <span class="gut">14</span>estimation of spectral gaps
              <ins>in random regular graphs</ins>.
            </div>
            <div class="dl">
              <span class="gut">15</span><span class="kw">\end</span>{abstract}
            </div>
            <div class="dl"><span class="gut">16</span></div>
            <div class="dl">
              <span class="gut">17</span
              ><span class="kw">\section</span>{Preliminaries}
            </div>
            <div class="dl add">
              <span class="gut">18</span>Let <span class="m">$G$</span> be a
              <ins>$d$-regular</ins> graph<ins> on $n$ vertices.</ins>
            </div>
          </div>
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
/* Diff editor spans the full content width — no sidebar in this slice. */
.diff {
  flex: 1;
}
.diff-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.pane + .pane {
  border-left: 1px solid #000;
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  background: #252526;
  border-bottom: 1px solid var(--color-border);
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  color: var(--wa-color-text-normal);
}
.ph-ic {
  font-size: 12px;
}
.ph-tag {
  margin-left: auto;
  font-family: var(--vp-font-family-base);
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  background: #2c2c2c;
  border-radius: 999px;
  padding: 1px 8px;
}
.ph-tag--new {
  color: #c89be0;
  background: rgba(200, 155, 224, 0.14);
}

/* Diff body reuses .result/.tabs/.tab/.t-ic from mockup.css; the two-pane
   gutter layout below is unique to the compare editor. */
.diff-surface {
  padding: 8px 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  color: var(--wa-color-text-normal);
  line-height: 1.7;
}
.dl {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 0 14px 0 0;
  white-space: pre-wrap;
}
.gut {
  flex-shrink: 0;
  width: 30px;
  text-align: right;
  padding-right: 6px;
  color: var(--color-text-tertiary);
  border-right: 1px solid var(--color-border);
  user-select: none;
}
.dl.chg {
  background: rgba(241, 76, 76, 0.1);
}
.dl.add {
  background: rgba(46, 160, 67, 0.12);
}
.dl del {
  background: rgba(241, 76, 76, 0.28);
  color: #ffb3b3;
  text-decoration: line-through;
  border-radius: 2px;
  padding: 0 1px;
}
.dl ins {
  background: rgba(46, 160, 67, 0.32);
  color: #b6f0c0;
  text-decoration: none;
  border-radius: 2px;
  padding: 0 1px;
}

/* On narrow screens the two panes stack like VS Code's inline diff. */
@media (max-width: 820px) {
  .diff-body {
    flex-direction: column;
  }
  .pane + .pane {
    border-left: none;
    border-top: 1px solid #000;
  }
}
</style>
