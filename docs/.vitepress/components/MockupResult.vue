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
/* Design tokens are defined on .win in LandingHero.vue and inherit here. */
.result {
  display: flex;
  flex-direction: column;
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
  background: #2d2d2d;
  border: none;
  border-right: 1px solid #1a1a1a;
  color: var(--color-text-secondary);
  font-size: 0.76rem;
  padding: 8px 14px;
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
}
.tab:hover {
  color: var(--wa-color-text-normal);
}
.tab.active {
  background: #1e1e1e;
  color: #fff;
  box-shadow: inset 0 2px 0 #c89be0;
}
.t-ic {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  font-size: 12px;
}
.t-pdf {
  color: #e0524f;
}
.t-wolf {
  color: #d9491c;
}
.t-lean {
  color: #b388e0;
  font-style: italic;
  font-weight: 700;
  font-size: 0.9rem;
  line-height: 1;
}

/* Rendered diff "PDF" page — fills the editor like a real PDF preview */
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
.page sub,
.page sup {
  font-size: 0.7em;
}
.qed {
  float: right;
}

/* Wolfram / Lean panes */
.term {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 16px;
  padding: 16px 18px;
  background: #141414;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.75;
  color: var(--wa-color-text-normal);
}
.cmt {
  color: #6a9955;
}
.wl {
  color: var(--wa-color-text-normal);
}
.wl.indent {
  padding-left: 1.5em;
}
.wl.out {
  color: #9cdcfe;
  margin-top: 4px;
}
.term-note {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
  font-family: var(--vp-font-family-base);
  font-size: 0.8rem;
  line-height: 1.55;
  color: var(--color-text-secondary);
}
.term-ok {
  display: inline-block;
  margin-top: 6px;
  color: #6abf69;
  font-weight: 600;
}
.term-lean .ln {
  white-space: pre;
}
.term-lean .kw {
  color: #c586c0;
}
.term-lean .tac {
  color: #4ec9b0;
}
.indent {
  padding-left: 1.2em;
}
.indent2 {
  padding-left: 2.4em;
}

@media (max-width: 820px) {
  .page {
    font-size: 0.78rem;
  }
}
</style>
