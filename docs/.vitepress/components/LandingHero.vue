<script setup>
import { ref } from 'vue';
import { withBase } from 'vitepress';

// Right-panel view of the same task: the written diff, the numeric
// cross-check, or the formal proof. One task, three ways to trust it.
const view = ref('diff');
</script>

<template>
  <div class="lh">
    <p class="lh-eyebrow">Multi-agent AI for theorists</p>
    <h1 class="lh-headline">
      Derive it, check it,<br />
      write it into your paper.
    </h1>
    <p class="lh-tagline">
      You direct an orchestrator. It delegates to specialist agents that search
      real databases, compute in Wolfram, prove in Lean&nbsp;4 — and hand back
      every change as a diff you approve. In VS&nbsp;Code and the terminal.
    </p>
    <div class="lh-actions">
      <a class="lh-btn lh-btn-primary" :href="withBase('/guide/quick-start')">Get started</a>
      <a
        class="lh-btn lh-btn-alt"
        href="https://marketplace.visualstudio.com/items?itemName=texra-ai.texra"
        >Install for VS&nbsp;Code</a
      >
    </div>

    <!-- Product slice: a real TeXRA run, not a marketing illustration -->
    <div class="win" role="group" aria-label="TeXRA running an orchestrated research task in VS Code">
      <div class="win-bar">
        <span class="dot dot-r"></span>
        <span class="dot dot-y"></span>
        <span class="dot dot-g"></span>
        <span class="win-title">spectral-gap.tex — TeXRA</span>
      </div>
      <div class="win-body">
        <!-- Left: the agent panel, orchestrator delegating -->
        <aside class="chat">
          <div class="chat-head">
            <span class="chat-agent">
              <span class="chat-glyph">◇</span> orchestrator
            </span>
            <span class="chat-model">Claude Opus 4.7</span>
          </div>
          <div class="msg msg-user">
            Derive the spectral-gap bound for <i>d</i>-regular random graphs,
            cross-check it numerically, and tighten the notation in §2–3.
          </div>
          <div class="msg msg-agent">
            Breaking this into three steps and delegating to specialists.
          </div>
          <ul class="steps">
            <li>
              <span class="step-name">research</span>
              <span class="step-detail">derived λ₂ ≲ 2√(d−1)</span>
              <span class="step-ok">✓</span>
            </li>
            <li>
              <span class="step-name">numerics</span>
              <span class="step-detail">N=2000, λ₂ = 4.41</span>
              <span class="step-ok">✓</span>
            </li>
            <li>
              <span class="step-name">correct</span>
              <span class="step-detail">18 edits · diff ready</span>
              <span class="step-ok">✓</span>
            </li>
          </ul>
          <div class="approve">
            <button class="approve-btn" type="button" tabindex="-1">Approve all</button>
            <span class="approve-hint">review every diff first</span>
          </div>
        </aside>

        <!-- Right: the result, viewable three ways -->
        <section class="result">
          <div class="tabs">
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'diff' }"
              @click="view = 'diff'"
            >
              Diff
            </button>
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'wolfram' }"
              @click="view = 'wolfram'"
            >
              Wolfram
            </button>
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'lean' }"
              @click="view = 'lean'"
            >
              Lean 4
            </button>
          </div>

          <!-- Rendered latexdiff, on a white "PDF" page -->
          <div v-show="view === 'diff'" class="page">
            <h3 class="pg-h">2&nbsp;&nbsp;Preliminaries</h3>
            <p class="pg-p">
              <b>Definition 1.</b> <i>An <del>Erdös-Rényi</del><ins>Erdős–Rényi</ins>
              random graph G(n,&nbsp;p) is a graph on n vertices where each
              <del>posible edge</del><ins>possible edge</ins> {u,&nbsp;v} is included
              with probability p<del>independent</del><ins>, independently</ins> of
              all other edges.</i>
            </p>
            <p class="pg-p">
              Let <del>A be the adjacency matrix of a graph</del> G
              <ins>be a graph on n vertices</ins>. Its adjacency matrix
              A&nbsp;=&nbsp;A(G) is an n&nbsp;×&nbsp;n matrix where
              A<sub>uv</sub>&nbsp;=&nbsp;1 if {u,&nbsp;v} is an edge in
              G<del>. The eigenvalues of</del><ins>, and A<sub>uv</sub>&nbsp;=&nbsp;0
              otherwise. Since A</ins> <del>are denoted</del><ins>is symmetric, its
              eigenvalues are real and are denoted by</ins> λ₁&nbsp;≥&nbsp;λ₂&nbsp;≥&nbsp;⋯&nbsp;≥&nbsp;λₙ.
            </p>
            <h3 class="pg-h">3&nbsp;&nbsp;Spectral Gap in Random Regular Graphs</h3>
            <p class="pg-p">
              For a d-regular graph G<ins>&nbsp;(where every vertex has degree d)</ins>,
              it is well-known that <ins>the largest eigenvalue of its adjacency
              matrix is λ₁&nbsp;=&nbsp;d</ins>. The spectral gap, defined as
              d&nbsp;−&nbsp;λ₂, plays a crucial role in the expansion properties of
              the graph.
            </p>
          </div>

          <!-- Numeric cross-check -->
          <div v-show="view === 'wolfram'" class="term">
            <div class="cell-in"><span class="prompt">In[1]:=</span> A = AdjacencyMatrix[RandomRegularGraph[6, 2000]];</div>
            <div class="cell-in"><span class="prompt">In[2]:=</span> Rest[ReverseSort@Eigenvalues[N@A]] // First</div>
            <div class="cell-out"><span class="prompt out">Out[2]=</span> 4.41</div>
            <div class="term-note">
              analytic bound&nbsp;&nbsp;2√(d−1) = 2√5 ≈ 4.472&nbsp;… the measured
              λ₂ = 4.41 sits just inside the Ramanujan limit.
              <span class="term-ok">✓ bound holds</span>
            </div>
          </div>

          <!-- Formal proof -->
          <div v-show="view === 'lean'" class="term term-lean">
            <div class="ln"><span class="kw">theorem</span> spectral_gap_pos <span class="kw">(h</span> : 2 ≤ d) :</div>
            <div class="ln indent">d - mu2 G &gt; 0 := <span class="kw">by</span></div>
            <div class="ln indent2"><span class="tac">have</span> hμ : mu2 G &lt; d := alon_boppana hd</div>
            <div class="ln indent2"><span class="tac">linarith</span></div>
            <div class="term-note">
              <span class="term-ok">✓ proof compiles · 0 errors · 0 sorry</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lh {
  max-width: 1080px;
  margin: 0 auto;
  padding: 3.5rem 1.5rem 0;
  text-align: center;
}
.lh-eyebrow {
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin: 0 0 1rem;
}
.lh-headline {
  font-size: clamp(2.1rem, 5.4vw, 3.6rem);
  line-height: 1.07;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
  margin: 0 auto 1.25rem;
  border: none;
}
.lh-tagline {
  max-width: 640px;
  margin: 0 auto 1.75rem;
  font-size: 1.05rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.lh-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 3rem;
}
.lh-btn {
  display: inline-block;
  padding: 0.7rem 1.5rem;
  border-radius: 9px;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none !important;
  transition: transform 0.15s, background-color 0.2s, border-color 0.2s;
}
.lh-btn:hover {
  transform: translateY(-1px);
  text-decoration: none !important;
}
.lh-btn-primary {
  background: var(--vp-c-brand-1);
  color: #fff !important;
}
.lh-btn-primary:hover {
  background: var(--vp-c-brand-2);
}
.lh-btn-alt {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1) !important;
  border: 1px solid var(--vp-c-divider);
}
.lh-btn-alt:hover {
  border-color: var(--vp-c-brand-1);
}

/* ---- Product window (always dark, like a real editor) ---- */
.win {
  text-align: left;
  background: #1e1e1e;
  border: 1px solid #000;
  border-radius: 12px;
  overflow: hidden;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 24px 60px -20px rgba(0, 0, 0, 0.55),
    0 8px 20px -12px rgba(77, 33, 97, 0.45);
}
.win-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  background: #323233;
  border-bottom: 1px solid #000;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
}
.dot-r { background: #ff5f57; }
.dot-y { background: #febc2e; }
.dot-g { background: #28c840; }
.win-title {
  flex: 1;
  text-align: center;
  font-size: 0.8rem;
  color: #b4b4b4;
  font-family: var(--vp-font-family-mono);
  margin-right: 48px;
}
.win-body {
  display: grid;
  grid-template-columns: 320px 1fr;
  min-height: 420px;
}

/* Chat / agent panel */
.chat {
  background: #181818;
  border-right: 1px solid #000;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid #2a2a2a;
}
.chat-agent {
  font-family: var(--vp-font-family-mono);
  font-size: 0.84rem;
  color: #e6e6e6;
  font-weight: 600;
}
.chat-glyph { color: #c89be0; }
.chat-model {
  font-size: 0.68rem;
  color: #8a8a8a;
  background: #242424;
  border: 1px solid #333;
  border-radius: 5px;
  padding: 2px 7px;
}
.msg {
  font-size: 0.82rem;
  line-height: 1.5;
  border-radius: 9px;
  padding: 9px 11px;
}
.msg-user {
  background: #2a2140;
  color: #e9e2f3;
  border: 1px solid #3a2c57;
}
.msg-agent {
  background: #202020;
  color: #c4c4c4;
  border: 1px solid #2c2c2c;
}
.steps {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  background: #1c1c1c;
  border: 1px solid #2a2a2a;
  border-left: 2px solid #4ec9b0;
  border-radius: 7px;
  padding: 7px 9px;
}
.step-name {
  font-family: var(--vp-font-family-mono);
  color: #c89be0;
  font-weight: 600;
}
.step-detail {
  flex: 1;
  color: #9a9a9a;
}
.step-ok { color: #6abf69; font-weight: 700; }
.approve {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 8px;
}
.approve-btn {
  background: #4d2161;
  color: #f0e7f6;
  border: 1px solid #6a2f86;
  border-radius: 7px;
  padding: 7px 14px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: default;
}
.approve-hint {
  font-size: 0.72rem;
  color: #7a7a7a;
}

/* Result panel */
.result {
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
}
.tabs {
  display: flex;
  background: #252526;
  border-bottom: 1px solid #000;
}
.tab {
  background: transparent;
  border: none;
  border-right: 1px solid #1a1a1a;
  color: #9a9a9a;
  font-size: 0.8rem;
  padding: 9px 18px;
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
}
.tab:hover { color: #d4d4d4; }
.tab.active {
  background: #1e1e1e;
  color: #fff;
  box-shadow: inset 0 2px 0 #c89be0;
}

/* Rendered diff "PDF" page */
.page {
  background: #fdfdfb;
  color: #1a1a1a;
  margin: 16px;
  padding: 20px 24px;
  border-radius: 4px;
  font-family: 'Latin Modern Roman', Georgia, 'Times New Roman', serif;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.pg-h {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 0.4rem 0 0.55rem;
  color: #111;
  border: none;
  padding: 0;
}
.pg-h:first-child { margin-top: 0; }
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
.page sub { font-size: 0.7em; }

/* Wolfram / Lean terminal panes */
.term {
  margin: 16px;
  padding: 16px 18px;
  background: #141414;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.75;
  color: #d4d4d4;
}
.cell-in { color: #dcdcaa; }
.cell-out { color: #9cdcfe; }
.prompt { color: #6a9955; margin-right: 8px; }
.prompt.out { color: #c586c0; }
.term-note {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #2a2a2a;
  font-family: var(--vp-font-family-base);
  font-size: 0.8rem;
  line-height: 1.55;
  color: #9a9a9a;
}
.term-ok {
  display: inline-block;
  margin-top: 6px;
  color: #6abf69;
  font-weight: 600;
}
.term-lean .ln { white-space: pre; }
.term-lean .kw { color: #c586c0; }
.term-lean .tac { color: #4ec9b0; }
.indent { padding-left: 1.2em; }
.indent2 { padding-left: 2.4em; }

@media (max-width: 760px) {
  .lh { padding-top: 2.5rem; }
  .win-body {
    grid-template-columns: 1fr;
  }
  .chat {
    border-right: none;
    border-bottom: 1px solid #000;
  }
  .win-title { margin-right: 0; }
  .page { font-size: 0.78rem; }
}
</style>
