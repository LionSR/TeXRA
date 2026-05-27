<script setup>
// Editor pane: the files the run produced, shown three ways. `view` is shared
// with the parent so the tabs stay in sync with the sidebar's tool-use rows.
const view = defineModel('view', { type: String, default: 'diff' });
</script>

<template>
  <div class="result">
    <div class="tabs">
      <button
        type="button"
        class="tab"
        :class="{ active: view === 'diff' }"
        @click="view = 'diff'"
      >
        <wa-icon class="t-ic t-pdf" library="texra" name="file-pdf"></wa-icon
        >spectral-gap-diff.pdf
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: view === 'wolfram' }"
        @click="view = 'wolfram'"
      >
        <wa-icon class="t-ic t-wolf" library="texra" name="file-code"></wa-icon
        >cross_check.wls
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: view === 'lean' }"
        @click="view = 'lean'"
      >
        <span class="t-ic t-lean">λ</span>SpectralGap.lean
      </button>
    </div>

    <!-- Compiled latexdiff, shown in the PDF preview -->
    <div v-show="view === 'diff'" class="page">
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
        A<sub>uv</sub>&nbsp;=&nbsp;1 if {u,&nbsp;v} is an edge in G<del
          >. The eigenvalues of</del
        ><ins>, and A<sub>uv</sub>&nbsp;=&nbsp;0 otherwise. Since A</ins>
        <del>are denoted</del
        ><ins>is symmetric, its eigenvalues are real and are denoted by</ins>
        λ₁&nbsp;≥&nbsp;λ₂&nbsp;≥&nbsp;⋯&nbsp;≥&nbsp;λₙ.
      </p>
      <h3 class="pg-h">3&nbsp;&nbsp;Spectral Gap in Random Regular Graphs</h3>
      <p class="pg-p">
        For a d-regular graph G<ins>&nbsp;(where every vertex has degree d)</ins
        >, it is well-known that
        <ins
          >the largest eigenvalue of its adjacency matrix is
          λ₁&nbsp;=&nbsp;d</ins
        >. The spectral gap, defined as d&nbsp;−&nbsp;λ₂, plays a crucial role
        in the expansion properties of the graph.
      </p>
      <p class="pg-p">
        <b>Theorem 2 (Alon–Boppana).</b>
        <i
          >For a d-regular graph on n vertices, <del>λ₂ is large</del
          ><ins>λ₂&nbsp;≥&nbsp;2√(d−1)&nbsp;−&nbsp;o(1) as n&nbsp;→&nbsp;∞</ins
          >.</i
        >
        A d-regular graph meeting this bound with equality is called a
        <del>good expander</del><ins>Ramanujan graph</ins>.
      </p>
      <p class="pg-p">
        <i>Proof.</i> <del>It follows from counting walks.</del
        ><ins
          >Count closed walks of length 2k rooted at a fixed vertex. The number
          of such walks in the d-regular tree is the Catalan-weighted moment
          C<sub>k</sub>&nbsp;(d−1)<sup>k</sup>, and</ins
        >
        comparing with tr(A<sup>2k</sup>)&nbsp;=&nbsp;Σ<sub>i</sub>&nbsp;λ<sub
          >i</sub
        ><sup>2k</sup>
        <ins
          >as n&nbsp;→&nbsp;∞ forces
          λ₂&nbsp;≥&nbsp;2√(d−1)&nbsp;−&nbsp;o(1).</ins
        >
        <span class="qed">∎</span>
      </p>
    </div>

    <!-- Numeric cross-check (WolframScript) -->
    <div v-show="view === 'wolfram'" class="term">
      <div class="cmt">
        (* second eigenvalue of a random 6-regular graph, N = 2000 *)
      </div>
      <div class="wl">A = AdjacencyMatrix @ RandomGraph @</div>
      <div class="wl indent">
        DegreeGraphDistribution @ ConstantArray[6, 2000];
      </div>
      <div class="wl">λ2 = Max @ Rest @ ReverseSort @ Eigenvalues @ N @ A</div>
      <div class="wl out">4.41</div>
      <div class="term-note">
        analytic bound&nbsp;&nbsp;2√(d−1) = 2√5 ≈ 4.472&nbsp;… the measured λ₂ =
        4.41 sits just inside the Ramanujan limit.
        <span class="term-ok">✓ bound holds</span>
      </div>
    </div>

    <!-- Formal proof -->
    <div v-show="view === 'lean'" class="term term-lean">
      <div class="ln">
        <span class="kw">theorem</span> spectral_gap_pos
        <span class="kw">(h</span> : 2 ≤ d) :
      </div>
      <div class="ln indent">
        d - mu2 G &gt; 0 := <span class="kw">by</span>
      </div>
      <div class="ln indent2">
        <span class="tac">have</span> hμ : mu2 G &lt; d := alon_boppana hd
      </div>
      <div class="ln indent2"><span class="tac">linarith</span></div>
      <div class="term-note">
        <span class="term-ok">✓ proof compiles · 0 errors · 0 sorry</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Window chrome, editor shell, tokens, and the shared diff-page / terminal
   surfaces come from MockupFrame + theme/mockup.css; this file adds only the
   rules unique to these panes. */
.wl.indent {
  padding-left: 1.5em;
}
.qed {
  float: right;
}

@media (max-width: 820px) {
  .page {
    font-size: 0.78rem;
  }
}
</style>
