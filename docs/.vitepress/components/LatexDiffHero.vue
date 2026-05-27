<script setup>
// LaTeX Diff product slice: the LaTeXdiffs section (base vs. edited pickers,
// the latexdiff button, git-commit comparison) beside the compiled, color-
// coded diff PDF that TeXRA opens for you.
import MockupFrame from './MockupFrame.vue';
</script>

<template>
  <MockupFrame title="spectral-gap — texra-paper">
    <aside class="board">
      <div class="board-tabs">
        <span class="bt bt-on"
          ><wa-icon library="texra" name="chevron-down"></wa-icon>
          LaTeXdiffs</span
        >
      </div>

      <div class="diffui">
        <div class="field">
          <span class="f-label"
            ><wa-icon library="texra" name="file"></wa-icon> Base</span
          >
          <div class="select">
            <span class="s-val">spectral-gap.tex</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>

        <div class="field">
          <span class="f-label"
            ><wa-icon library="texra" name="edit"></wa-icon> Edited</span
          >
          <div class="select">
            <span class="s-val">spectral-gap_polish_r1.tex</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary">
            <wa-icon library="texra" name="diff-single"></wa-icon> latexdiff
          </button>
          <button class="btn">
            <wa-icon library="texra" name="git-merge"></wa-icon> Merge
          </button>
        </div>

        <div class="sep">Git comparison</div>

        <div class="field">
          <span class="f-label"
            ><wa-icon library="texra" name="git-commit"></wa-icon> Commit</span
          >
          <div class="select">
            <span class="s-val s-mono">a3f9c1 · unify notation</span>
            <wa-icon class="s-caret" library="texra" name="refresh"></wa-icon>
          </div>
        </div>
        <button class="btn btn-wide">
          <wa-icon library="texra" name="diff-single"></wa-icon> latexdiff-vc
        </button>

        <div class="hint">
          The compiled diff opens automatically — additions in blue, deletions
          struck through in red.
        </div>
      </div>
    </aside>

    <!-- Editor: the compiled diff PDF -->
    <div class="result">
      <div class="tabs">
        <button type="button" class="tab active">
          <wa-icon class="t-ic t-pdf" library="texra" name="file-pdf"></wa-icon
          >spectral-gap_diff.pdf
        </button>
      </div>
      <div class="page">
        <h3 class="pg-h">2&nbsp;&nbsp;Preliminaries</h3>
        <p class="pg-p">
          <b>Definition 1.</b>
          <i
            >An <del>Erdös-Rényi</del><ins>Erdős–Rényi</ins> random graph
            G(n,&nbsp;p) is a graph on n vertices where each
            <del>posible edge</del><ins>possible edge</ins> {u,&nbsp;v} is
            included with probability p<del>independent</del
            ><ins>, independently</ins> of all other edges.</i
          >
        </p>
        <p class="pg-p">
          Let <del>A be the adjacency matrix of a graph</del> G
          <ins>be a graph on n vertices</ins>. Its adjacency matrix
          A&nbsp;=&nbsp;A(G) is an n&nbsp;×&nbsp;n matrix where
          A<sub>uv</sub>&nbsp;=&nbsp;1 if {u,&nbsp;v} is an edge<ins
            >, and A<sub>uv</sub>&nbsp;=&nbsp;0 otherwise. Since A</ins
          >
          <del>are denoted</del
          ><ins>is symmetric, its eigenvalues are real and are denoted by</ins>
          λ₁&nbsp;≥&nbsp;λ₂&nbsp;≥&nbsp;⋯&nbsp;≥&nbsp;λₙ.
        </p>
        <h3 class="pg-h">3&nbsp;&nbsp;Spectral Gap</h3>
        <p class="pg-p">
          For a d-regular graph G<ins
            >&nbsp;(where every vertex has degree d)</ins
          >, it is well-known that
          <ins>the largest eigenvalue is λ₁&nbsp;=&nbsp;d</ins>. The spectral
          gap, defined as d&nbsp;−&nbsp;λ₂, governs the expansion properties of
          the graph.
        </p>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
.board {
  flex-shrink: 0;
  width: 300px;
  background: #1e1e1e;
  border-right: 1px solid #000;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.board-tabs {
  display: flex;
  height: 36px;
  padding: 0 8px;
  background: #252526;
  border-bottom: 1px solid #000;
}
.bt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  font-size: 0.74rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.bt wa-icon {
  font-size: 11px;
}
.bt-on {
  color: #fff;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #c89be0;
}

.diffui {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 14px 12px;
  font-family: var(--vp-font-family-base);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.f-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}
.f-label wa-icon {
  font-size: 11px;
}
.select {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #2c2c2c;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  padding: 6px 9px;
  font-size: 0.78rem;
  color: var(--wa-color-text-normal);
}
.s-val {
  font-family: var(--vp-font-family-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-mono {
  color: var(--color-text-secondary);
}
.s-caret {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.btn-row {
  display: flex;
  gap: 7px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  padding: 7px 9px;
  background: #2c2c2c;
  color: var(--wa-color-text-normal);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--vp-font-family-base);
}
.btn wa-icon {
  font-size: 12px;
}
.btn-primary {
  background: #8957b5;
  border-color: #8957b5;
  color: #fff;
}
.btn-wide {
  width: 100%;
}
.sep {
  margin-top: 2px;
  font-size: 0.64rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  border-top: 1px solid var(--color-border);
  padding-top: 10px;
}
.hint {
  margin-top: 4px;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

/* Editor / diff PDF */
.result {
  display: flex;
  flex-direction: column;
  flex: 1;
  background: #1e1e1e;
  min-width: 0;
}
.tabs {
  display: flex;
  background: #252526;
  border-bottom: 1px solid #000;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: #1e1e1e;
  border: none;
  border-right: 1px solid #1a1a1a;
  color: #fff;
  font-size: 0.74rem;
  padding: 8px 14px;
  cursor: default;
  font-family: var(--vp-font-family-mono);
  box-shadow: inset 0 2px 0 #c89be0;
}
.t-ic {
  display: inline-flex;
  flex-shrink: 0;
  font-size: 12px;
}
.t-pdf {
  color: #e0524f;
}
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: #fdfdfb;
  color: #1a1a1a;
  margin: 16px;
  padding: 22px 26px;
  border-radius: 4px;
  font-family: 'Latin Modern Roman', Georgia, 'Times New Roman', serif;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
}
.pg-h {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 0.4rem 0 0.55rem;
  color: #111;
  border: none;
  padding: 0;
}
.pg-h:first-child {
  margin-top: 0;
}
.pg-p {
  font-size: 0.84rem;
  line-height: 1.65;
  margin: 0 0 0.7rem;
  color: #1a1a1a;
}
.page del {
  color: #c0392b;
  text-decoration: line-through;
}
.page ins {
  color: #1f4fd6;
  text-decoration: underline;
}
.page sub {
  font-size: 0.7em;
}

@media (max-width: 820px) {
  .board {
    width: auto;
    border-right: none;
    border-bottom: 1px solid #000;
  }
}
</style>
