<script setup>
// LaTeX Diff product slice: the LaTeXDiffs sheet beside the compiled, color-
// coded diff PDF. Mirrors LatexDiffsSection.ts: Base / Edited / Commit rows,
// each a labelled <wa-select> with icon actions in its header and, for Edited
// and Commit, the labelled action buttons under it.
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
              <span class="act" title="Refresh edited files"
                ><wa-icon library="texra" name="refresh"></wa-icon
              ></span>
              <span class="act" title="Set current file as edited"
                ><wa-icon library="texra" name="file-code"></wa-icon
              ></span>
              <span class="act" title="Clear edited file"
                ><wa-icon library="texra" name="close"></wa-icon
              ></span>
            </div>
          </div>
          <div class="select">
            <span class="s-val">r1/spectral-gap.tex</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
          <div class="dacts">
            <span class="act act-on"
              ><wa-icon library="texra" name="diff-single"></wa-icon> Diff vs.
              edited</span
            >
            <span class="act"
              ><wa-icon library="texra" name="diff"></wa-icon> Compare</span
            >
            <span class="act"
              ><wa-icon library="texra" name="merge"></wa-icon> Merge</span
            >
            <span class="act"
              ><wa-icon library="texra" name="check"></wa-icon> Accept</span
            >
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
              <span class="act" title="Refresh commit list"
                ><wa-icon library="texra" name="refresh"></wa-icon
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
          <div class="dacts">
            <span class="act"
              ><wa-icon library="texra" name="diff-single"></wa-icon> Diff vs.
              commit</span
            >
            <span class="act"
              ><wa-icon library="texra" name="archive"></wa-icon> Move to Diffs
              folder</span
            >
            <span class="act"
              ><wa-icon library="texra" name="trash"></wa-icon> Delete diff
              files</span
            >
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

/* The labelled action buttons under a selector. */
.dacts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-4);
  margin-top: var(--mk-space-6);
}
.dacts .act {
  width: auto;
  gap: var(--mk-space-5);
  padding: var(--mk-space-3) var(--mk-space-7);
  border: 1px solid var(--color-border);
  font-size: var(--mk-fs-70);
}
</style>
