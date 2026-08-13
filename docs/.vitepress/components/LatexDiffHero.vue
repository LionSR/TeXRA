<script setup>
// LaTeX Diff product slice: the LaTeXDiffs section beside the compiled, color-
// coded diff PDF. Mirrors LatexDiffsSection.ts — a source-control-labelled
// collapsible with Base / Edited / Commit rows, each a labelled <wa-select>
// fronted by a toolbar of icon actions.
import MockupFrame from './MockupFrame.vue';
</script>

<template>
  <MockupFrame title="spectral-gap — texra-paper">
    <aside class="board">
      <div class="diffui">
        <div class="sechead">
          <wa-icon class="chev" library="texra" name="chevron-up"></wa-icon>
          <wa-icon
            class="sec-ic"
            library="texra"
            name="source-control"
          ></wa-icon>
          <span class="sec-lbl">LaTeXDiffs</span>
        </div>

        <!-- Base -->
        <div class="field">
          <div class="frow">
            <span class="f-label">Base</span>
            <div class="acts">
              <span class="act" title="Set current file as base"
                ><wa-icon library="texra" name="file-code"></wa-icon
              ></span>
              <span class="act" title="Clear base file"
                ><wa-icon library="texra" name="close"></wa-icon
              ></span>
            </div>
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

        <!-- Edited -->
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
              <span class="act" title="Merge edits"
                ><wa-icon library="texra" name="merge"></wa-icon
              ></span>
              <span class="act act-on" title="LaTeXdiff"
                ><wa-icon library="texra" name="diff-single"></wa-icon
              ></span>
            </div>
          </div>
          <div class="select">
            <span class="s-val">spectral-gap_polish_r1.tex</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>

        <!-- Commit (git) -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon
                class="lbl-ic"
                library="texra"
                name="git-commit"
              ></wa-icon>
              Commit</span
            >
            <div class="acts">
              <span class="act" title="LaTeXdiff with commit"
                ><wa-icon library="texra" name="diff-single"></wa-icon
              ></span>
              <span class="act" title="Pack latexdiff output"
                ><wa-icon library="texra" name="archive"></wa-icon
              ></span>
              <span class="act" title="Clean latexdiff output"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
            </div>
          </div>
          <div class="select">
            <span class="s-val s-mute">a3f9c1 · unify notation</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
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
  width: var(--mk-size-300);
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
.s-mute {
  color: var(--color-text-secondary);
}
</style>
