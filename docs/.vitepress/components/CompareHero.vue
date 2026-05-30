<script setup>
// Review-results product slice: the VS Code diff editor TeXRA opens after a
// run — the round-0 output (r0/draft.tex) with TeXRA's suggestions on the left,
// the previous draft on the right, with improved text added in green (left) and
// removed text struck in red (right). Accept-change arrows in the central gutter
// pull each hunk leftward, from the previous draft into the TeXRA suggestions.
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
        <!-- Revised — TeXRA's suggestions (left) -->
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
            <div class="dl add hunk-start">
              <button class="accept" title="Accept change">
                <wa-icon library="texra" name="arrow-left"></wa-icon>
              </button>
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
            <div class="dl add hunk-start">
              <button class="accept" title="Accept change">
                <wa-icon library="texra" name="arrow-left"></wa-icon>
              </button>
              <span class="gut">18</span>Let <span class="m">$G$</span> be a
              <ins>$d$-regular</ins> graph.
            </div>
          </div>
        </div>

        <!-- Previous draft (right) -->
        <div class="pane">
          <div class="pane-head">
            <wa-icon
              class="ph-ic t-tex"
              library="texra"
              name="file-code"
            ></wa-icon>
            draft.tex
            <span class="ph-tag">Previous draft</span>
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
              graph.
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
  border-left: 1px solid var(--mk-border-strong);
}
.pane-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-6) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--color-border);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--wa-color-text-normal);
}
.ph-ic {
  font-size: var(--mk-space-12);
}
.ph-tag {
  margin-left: auto;
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-8);
}
.ph-tag--new {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
}

/* Diff body reuses .result/.tabs/.tab/.t-ic from mockup.css; the two-pane
   gutter layout below is unique to the compare editor. */
.diff-surface {
  padding: var(--mk-space-8) 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-82);
  color: var(--wa-color-text-normal);
  line-height: 1.7;
}
.dl {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-10);
  padding: 0 var(--mk-space-14) 0 0;
  white-space: pre-wrap;
}
.gut {
  flex-shrink: 0;
  width: var(--mk-size-30);
  text-align: right;
  padding-right: var(--mk-space-6);
  color: var(--color-text-tertiary);
  border-right: 1px solid var(--color-border);
  user-select: none;
}
.dl.chg {
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
}
.dl.add {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
}
.dl del {
  background: color-mix(in srgb, var(--color-error) 28%, transparent);
  color: var(--mk-del-text);
  text-decoration: line-through;
  border-radius: var(--mk-radius-xs);
  padding: 0 1px;
}
.dl ins {
  background: color-mix(in srgb, var(--color-success) 32%, transparent);
  color: var(--mk-ins-text);
  text-decoration: none;
  border-radius: var(--mk-radius-xs);
  padding: 0 1px;
}

/* Accept-change control in the central gutter: like VS Code's diff editor,
   one arrow per hunk pointing right-to-left — pulling each hunk from the
   previous draft (right) into the TeXRA suggestions (left). It straddles the
   divider at the left pane's right edge. */
.dl.hunk-start {
  position: relative;
}
.accept {
  position: absolute;
  right: -13px;
  top: var(--mk-space-2);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-24);
  height: var(--mk-size-21);
  padding: 0;
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  background: var(--mk-bg-raised);
  color: var(--mk-accent);
  font-size: var(--mk-space-12);
  cursor: pointer;
  box-shadow: 0 2px 7px rgba(0, 0, 0, 0.45);
}
.accept:hover {
  background: color-mix(in srgb, var(--mk-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--mk-accent) 60%, transparent);
}

/* On narrow screens the two panes stack like VS Code's inline diff. */
@media (max-width: 820px) {
  .diff-body {
    flex-direction: column;
  }
  .pane + .pane {
    border-left: none;
    border-top: 1px solid var(--mk-border-strong);
  }
}
</style>
