<script setup>
import { ref } from 'vue';
import { withBase } from 'vitepress';

// Right-panel view of the same task: the written diff, the numeric
// cross-check, or the formal proof. One task, three ways to trust it.
const view = ref('diff');
const installOpen = ref(false);
const copied = ref(false);

const CLI = 'npm install -g @texra-ai/cli';

// Codicon-style glyphs matching the real ProgressBoard tool icons.
const ICON_AGENT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="5.3" r="2.5"/><path d="M3 13.5c0-2.9 10-2.9 10 0"/></svg>';
const ICON_DIFF =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 2v8M5 13.5v.5"/><path d="M11 6v8M11 2v.5"/><path d="M3 6h4M9 10h4"/></svg>';

// Editors all resolve to their respective marketplaces; Cursor, Windsurf and
// other VS Code forks install TeXRA from Open VSX.
const editors = [
  {
    name: 'VS Code',
    note: 'Marketplace',
    href: 'https://marketplace.visualstudio.com/items?itemName=texra-ai.texra',
  },
  {
    name: 'Cursor',
    note: 'Open VSX',
    href: 'https://open-vsx.org/extension/texra-ai/texra',
  },
  {
    name: 'Windsurf',
    note: 'Open VSX',
    href: 'https://open-vsx.org/extension/texra-ai/texra',
  },
  {
    name: 'Other editors',
    note: 'Open VSX',
    href: 'https://open-vsx.org/extension/texra-ai/texra',
  },
];

function copyCli() {
  try {
    navigator.clipboard?.writeText(CLI);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable */
  }
}
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
      every change as a diff you approve. In VS&nbsp;Code, its forks, and the
      terminal.
    </p>

    <div class="lh-actions">
      <a class="lh-btn lh-btn-primary" :href="withBase('/guide/quick-start')"
        >Get started</a
      >
      <div class="lh-install">
        <button
          type="button"
          class="lh-btn lh-btn-alt lh-install-trigger"
          :aria-expanded="installOpen"
          @click="installOpen = !installOpen"
        >
          Add to your editor
          <span class="lh-caret" :class="{ open: installOpen }">▾</span>
        </button>
        <div v-show="installOpen" class="lh-menu" role="menu">
          <a
            v-for="e in editors"
            :key="e.name"
            class="lh-menu-item"
            role="menuitem"
            :href="e.href"
            target="_blank"
            rel="noopener"
            @click="installOpen = false"
          >
            <span class="lh-menu-name">{{ e.name }}</span>
            <span class="lh-menu-note">{{ e.note }}</span>
          </a>
        </div>
      </div>
    </div>

    <!-- CLI install, kept prominent -->
    <div class="lh-cli">
      <span class="lh-cli-label">or run it anywhere from your terminal</span>
      <div class="lh-cli-pill">
        <code><span class="lh-cli-dollar">$</span> {{ CLI }}</code>
        <button type="button" class="lh-copy" @click="copyCli">
          {{ copied ? 'copied' : 'copy' }}
        </button>
      </div>
    </div>

    <div
      v-show="installOpen"
      class="lh-backdrop"
      @click="installOpen = false"
    ></div>

    <!-- Product slice: a real TeXRA run, not a marketing illustration -->
    <div
      class="win"
      role="group"
      aria-label="TeXRA running an orchestrated research task in VS Code"
    >
      <div class="win-bar">
        <span class="dot dot-r"></span>
        <span class="dot dot-y"></span>
        <span class="dot dot-g"></span>
        <span class="win-title">spectral-gap.tex — TeXRA</span>
      </div>
      <div class="win-body">
        <!-- VS Code activity bar -->
        <nav class="act">
          <span class="act-i">▢</span>
          <span class="act-i">⌕</span>
          <span class="act-i">⑂</span>
          <span class="act-i act-on"><span class="act-glyph">🧠</span></span>
          <span class="act-i">⚙</span>
        </nav>

        <!-- Left: the TeXRA ProgressBoard (orchestrator = tool-use agent) -->
        <aside class="board">
          <div class="board-tabs">
            <span class="bt">Problems</span>
            <span class="bt">Output</span>
            <span class="bt">Terminal</span>
            <span class="bt bt-on">TeXRA ProgressBoard</span>
          </div>

          <div class="stream-head">
            <span class="sh-name">orchestrator@opus47</span>
            <span class="sh-dot" title="Running"></span>
            <span class="sh-badge"><span class="sh-pulse"></span>3 turns</span>
            <span class="sh-tools">▢ ↻ ⟂</span>
          </div>

          <div class="board-scroll">
            <!-- Todos panel -->
            <div class="panel">
              <div class="panel-sum">
                <span class="chev">▾</span> Todos (2/3)
              </div>
              <div class="panel-body todos">
                <div class="todo done">
                  <span class="td-ic">✓</span
                  ><span class="td-tx">Derive the spectral-gap bound</span>
                </div>
                <div class="todo done">
                  <span class="td-ic">✓</span
                  ><span class="td-tx">Cross-check λ₂ numerically</span>
                </div>
                <div class="todo prog">
                  <span class="td-sp"></span
                  ><span class="td-tx">Revising notation in §2–3</span>
                </div>
              </div>
            </div>

            <!-- Background Tasks → Subagents -->
            <div class="panel">
              <div class="panel-sum">
                <span class="chev">▾</span> Background Tasks
              </div>
              <div class="panel-body">
                <div class="sec-label">
                  <span class="chev">▾</span> Subagents · 1 active · 3 done
                </div>
                <div class="task">
                  <span class="task-ic">🤖</span>
                  <span class="task-name">correct</span>
                  <span class="task-desc">(revising spectral-gap.tex)</span>
                  <span class="task-elapsed">(0:18)</span>
                  <span class="task-tag">running</span>
                </div>
              </div>
            </div>

            <!-- Conversation log: user message, reasoning, tool-use cards -->
            <div class="log">
              <div class="umsg">
                <span class="umsg-ic">❝</span>
                Derive the spectral-gap bound for d-regular random graphs,
                cross-check it numerically, and tighten the notation in §2–3.
              </div>

              <div class="reason">
                I'll delegate the derivation, verify it two ways — numerically
                and in Lean — then revise the prose and return a diff.
              </div>

              <button
                class="tcard"
                :class="{ active: view === 'diff' }"
                @click="view = 'diff'"
              >
                <span class="tc-ic" v-html="ICON_AGENT"></span>
                <span class="tc-main">
                  <span class="tc-label"
                    ><span class="tc-tool">delegate_agent</span> —
                    research</span
                  >
                  <span class="tc-sub">derive λ₂ bound</span>
                </span>
                <span class="chev tc-chev">▸</span>
              </button>

              <button
                class="tcard"
                :class="{ active: view === 'wolfram' }"
                @click="view = 'wolfram'"
              >
                <span class="tc-ic" v-html="ICON_AGENT"></span>
                <span class="tc-main">
                  <span class="tc-label"
                    ><span class="tc-tool">delegate_agent</span> —
                    numerics</span
                  >
                  <span class="tc-sub">cross-check N=2000 in Wolfram</span>
                </span>
                <span class="chev tc-chev">▸</span>
              </button>

              <button
                class="tcard"
                :class="{ active: view === 'lean' }"
                @click="view = 'lean'"
              >
                <span class="tc-ic" v-html="ICON_AGENT"></span>
                <span class="tc-main">
                  <span class="tc-label"
                    ><span class="tc-tool">delegate_agent</span> — lean</span
                  >
                  <span class="tc-sub">prove d − λ₂ &gt; 0</span>
                </span>
                <span class="chev tc-chev">▸</span>
              </button>

              <button
                class="tcard run"
                :class="{ active: view === 'diff' }"
                @click="view = 'diff'"
              >
                <span class="tc-sp"></span>
                <span class="tc-main">
                  <span class="tc-label"
                    ><span class="tc-tool">delegate_workflow</span> —
                    correct</span
                  >
                  <span class="tc-sub">unify λ₂ notation across §2–3</span>
                </span>
                <span class="chev tc-chev down">▾</span>
              </button>

              <div class="ldiff" @click="view = 'diff'">
                <span class="ldiff-ic" v-html="ICON_DIFF"></span>
                <span class="ldiff-lbl">Latexdiff result</span>
                <div class="ldiff-row">
                  <span class="ldiff-ok">✓</span>
                  <span class="ldiff-file">spectral-gap.tex</span>
                  <span class="ldiff-r">[r0]</span>
                  <span class="ldiff-arrow">→</span>
                  <span class="ldiff-r">[r1]</span>
                  (<span class="ldiff-link">diff</span>)
                </div>
              </div>
            </div>
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
              <span class="tab-dot td-diff"></span>spectral-gap.tex
            </button>
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'wolfram' }"
              @click="view = 'wolfram'"
            >
              <span class="tab-dot td-wolf"></span>Wolfram
            </button>
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'lean' }"
              @click="view = 'lean'"
            >
              <span class="tab-dot td-lean"></span>Lean&nbsp;4
            </button>
          </div>

          <!-- Rendered latexdiff, on a white "PDF" page -->
          <div v-show="view === 'diff'" class="page">
            <h3 class="pg-h">2&nbsp;&nbsp;Preliminaries</h3>
            <p class="pg-p">
              <b>Definition 1.</b>
              <i
                >An <del>Erdös-Rényi</del><ins>Erdős–Rényi</ins>
                random graph G(n,&nbsp;p) is a graph on n vertices where each
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
              ><ins
                >is symmetric, its eigenvalues are real and are denoted by</ins
              >
              λ₁&nbsp;≥&nbsp;λ₂&nbsp;≥&nbsp;⋯&nbsp;≥&nbsp;λₙ.
            </p>
            <h3 class="pg-h">
              3&nbsp;&nbsp;Spectral Gap in Random Regular Graphs
            </h3>
            <p class="pg-p">
              For a d-regular graph G<ins
                >&nbsp;(where every vertex has degree d)</ins
              >, it is well-known that
              <ins
                >the largest eigenvalue of its adjacency matrix is
                λ₁&nbsp;=&nbsp;d</ins
              >. The spectral gap, defined as d&nbsp;−&nbsp;λ₂, plays a crucial
              role in the expansion properties of the graph.
            </p>
          </div>

          <!-- Numeric cross-check -->
          <div v-show="view === 'wolfram'" class="term">
            <div class="cell-in">
              <span class="prompt">In[1]:=</span> A =
              AdjacencyMatrix[RandomRegularGraph[6, 2000]];
            </div>
            <div class="cell-in">
              <span class="prompt">In[2]:=</span>
              Rest[ReverseSort@Eigenvalues[N@A]] // First
            </div>
            <div class="cell-out">
              <span class="prompt out">Out[2]=</span> 4.41
            </div>
            <div class="term-note">
              analytic bound&nbsp;&nbsp;2√(d−1) = 2√5 ≈ 4.472&nbsp;… the
              measured λ₂ = 4.41 sits just inside the Ramanujan limit.
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
  position: relative;
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

/* ---- Actions: Get started + editor dropdown ---- */
.lh-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  position: relative;
  z-index: 30;
}
.lh-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.7rem 1.5rem;
  border-radius: 9px;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none !important;
  cursor: pointer;
  font-family: inherit;
  transition:
    transform 0.15s,
    background-color 0.2s,
    border-color 0.2s;
}
.lh-btn:hover {
  transform: translateY(-1px);
  text-decoration: none !important;
}
.lh-btn-primary {
  background: var(--vp-c-brand-1);
  color: #fff !important;
  border: 1px solid var(--vp-c-brand-1);
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
.lh-install {
  position: relative;
}
.lh-caret {
  font-size: 0.7rem;
  transition: transform 0.2s;
}
.lh-caret.open {
  transform: rotate(180deg);
}
.lh-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  min-width: 230px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 11px;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.3);
  padding: 0.4rem;
  z-index: 40;
}
.lh-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.7rem;
  border-radius: 7px;
  text-decoration: none !important;
  color: var(--vp-c-text-1) !important;
}
.lh-menu-item:hover {
  background: var(--vp-c-brand-soft);
}
.lh-menu-name {
  font-weight: 600;
  font-size: 0.9rem;
}
.lh-menu-note {
  font-size: 0.74rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}
.lh-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}

/* ---- CLI pill ---- */
.lh-cli {
  margin-bottom: 3rem;
}
.lh-cli-label {
  display: block;
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.5rem;
}
.lh-cli-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  padding: 0.5rem 0.5rem 0.5rem 0.9rem;
  max-width: 100%;
}
.lh-cli-pill code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  overflow-x: auto;
  background: none;
  padding: 0;
}
.lh-cli-dollar {
  color: var(--vp-c-brand-1);
  margin-right: 0.35rem;
  user-select: none;
}
.lh-copy {
  flex-shrink: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}
.lh-copy:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

/* ============================================
   PRODUCT WINDOW — faithful TeXRA / VS Code
   ============================================ */
.win {
  text-align: left;
  background: #1e1e1e;
  border: 1px solid #000;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  z-index: 1;
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
.dot-r {
  background: #ff5f57;
}
.dot-y {
  background: #febc2e;
}
.dot-g {
  background: #28c840;
}
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
  grid-template-columns: 46px 340px 1fr;
  min-height: 440px;
}

/* Activity bar */
.act {
  background: #2c2c2c;
  border-right: 1px solid #000;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 10px;
  gap: 14px;
}
.act-i {
  color: #7a7a7a;
  font-size: 1.1rem;
  width: 100%;
  text-align: center;
  position: relative;
  line-height: 1.4;
}
.act-on {
  color: #fff;
}
.act-on::before {
  content: '';
  position: absolute;
  left: 0;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: #c89be0;
}
.act-glyph {
  font-size: 0.95rem;
  filter: grayscale(0.1);
}

/* ProgressBoard */
.board {
  background: #1e1e1e;
  border-right: 1px solid #000;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.board-tabs {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 34px;
  padding: 0 12px;
  background: #252526;
  border-bottom: 1px solid #000;
  overflow: hidden;
}
.bt {
  font-size: 0.72rem;
  color: #7c7c7c;
  white-space: nowrap;
}
.bt-on {
  color: #fff;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #c89be0;
  padding-bottom: 7px;
  padding-top: 7px;
}
/* Stream header */
.stream-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a2a;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  min-width: 0;
  white-space: nowrap;
}
.sh-name {
  color: #e6e6e6;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sh-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3fb950;
  flex-shrink: 0;
  box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.6);
  animation: shpulse 1.8s infinite;
}
@keyframes shpulse {
  0% {
    box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.5);
  }
  70% {
    box-shadow: 0 0 0 5px rgba(63, 185, 80, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(63, 185, 80, 0);
  }
}
.sh-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.68rem;
  color: #c89be0;
  background: rgba(200, 155, 224, 0.12);
  border-radius: 999px;
  padding: 1px 8px;
  flex-shrink: 0;
}
.sh-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c89be0;
}
.sh-tools {
  margin-left: auto;
  color: #6f6f6f;
  letter-spacing: 2px;
  flex-shrink: 0;
}

.board-scroll {
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  overflow: hidden;
}

/* Collapsible panels (Todos, Background Tasks) */
.panel {
  border-bottom: 1px solid #2a2a2a;
}
.panel-sum {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  color: #c4c4c4;
  font-weight: 600;
}
.chev {
  color: #7a7a7a;
  font-size: 0.6rem;
}
.panel-body {
  padding: 2px 12px 9px 14px;
}
.sec-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #8a8a8a;
}

/* Todos */
.todos {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.todo {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.todo .td-tx {
  color: #cccccc;
}
.todo.done {
  opacity: 0.55;
}
.todo.done .td-tx {
  text-decoration: line-through;
  color: #8a8a8a;
}
.todo.prog .td-tx {
  color: #e6e6e6;
  font-weight: 600;
}
.td-ic {
  color: #3fb950;
  font-weight: 700;
  flex-shrink: 0;
}
.td-sp {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  border: 2px solid rgba(200, 155, 224, 0.3);
  border-top-color: #c89be0;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

/* Background task item */
.task {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}
.task-ic {
  font-size: 0.8rem;
  flex-shrink: 0;
}
.task-name {
  color: #e0e0e0;
  flex-shrink: 0;
}
.task-desc {
  color: #8a8a8a;
  font-size: 0.7rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-elapsed {
  color: #8a8a8a;
  font-size: 0.7rem;
  flex-shrink: 0;
}
.task-tag {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 0.64rem;
  color: #e0b341;
  background: rgba(215, 169, 62, 0.16);
  border-radius: 4px;
  padding: 1px 7px;
}

/* Conversation log */
.log {
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.umsg {
  background: #2a2140;
  color: #e9e2f3;
  border: 1px solid #3a2c57;
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.5;
  font-family: var(--vp-font-family-base);
  font-size: 0.78rem;
}
.umsg-ic {
  color: #b39ddb;
  margin-right: 4px;
  font-weight: 700;
}
.reason {
  color: #b9b9b9;
  line-height: 1.5;
  font-family: var(--vp-font-family-base);
  font-size: 0.78rem;
  padding: 0 2px;
}

/* Tool-use cards (banner-details summary rows) */
.tcard {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: #1c1c1c;
  border: 1px solid #2c2c2c;
  border-radius: 6px;
  padding: 7px 9px;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.tcard:hover {
  background: #232323;
  border-color: #383838;
}
.tcard.active {
  background: #2a2331;
  border-color: #5a4072;
}
.tc-ic {
  color: #75beff;
  flex-shrink: 0;
  display: inline-flex;
}
.tc-ic :deep(svg) {
  width: 14px;
  height: 14px;
  display: block;
}
.tc-sp {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid rgba(215, 169, 62, 0.3);
  border-top-color: #d7a93e;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
.tc-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.tc-label {
  color: #d8d8d8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tc-tool {
  color: #9a9a9a;
}
.tc-sub {
  color: #7c7c7c;
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tc-chev {
  flex-shrink: 0;
  align-self: center;
}
.tc-chev.down {
  color: #c89be0;
}

/* Latexdiff result banner */
.ldiff {
  background: #1c1c1c;
  border: 1px solid #2c2c2c;
  border-radius: 6px;
  padding: 6px 9px;
  cursor: pointer;
}
.ldiff-ic {
  color: #c89be0;
  display: inline-flex;
  vertical-align: -2px;
  margin-right: 5px;
}
.ldiff-ic :deep(svg) {
  width: 13px;
  height: 13px;
}
.ldiff-lbl {
  color: #c4c4c4;
}
.ldiff-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  padding-left: 2px;
  color: #8a8a8a;
}
.ldiff-ok {
  color: #3fb950;
  font-weight: 700;
}
.ldiff-file {
  color: #4daafc;
}
.ldiff-r {
  color: #8a8a8a;
}
.ldiff-arrow {
  color: #6f6f6f;
}
.ldiff-link {
  color: #4daafc;
}
.ldiff:hover .ldiff-link {
  text-decoration: underline;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---- Result panel ---- */
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
  background: transparent;
  border: none;
  border-right: 1px solid #1a1a1a;
  color: #9a9a9a;
  font-size: 0.78rem;
  padding: 8px 16px;
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
}
.tab:hover {
  color: #d4d4d4;
}
.tab.active {
  background: #1e1e1e;
  color: #fff;
  box-shadow: inset 0 -2px 0 #c89be0;
}
.tab-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
}
.td-diff {
  background: #4daafc;
}
.td-wolf {
  background: #d97a1a;
}
.td-lean {
  background: #9a5fc0;
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

/* Wolfram / Lean panes */
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
.cell-in {
  color: #dcdcaa;
}
.cell-out {
  color: #9cdcfe;
}
.prompt {
  color: #6a9955;
  margin-right: 8px;
}
.prompt.out {
  color: #c586c0;
}
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
  .win-body {
    grid-template-columns: 1fr;
  }
  .act {
    flex-direction: row;
    justify-content: flex-start;
    gap: 18px;
    padding: 0 12px;
    height: 40px;
    border-right: none;
    border-bottom: 1px solid #000;
  }
  .act-on::before {
    left: -2px;
    top: auto;
    bottom: 0;
    right: -2px;
    width: auto;
    height: 2px;
  }
  .board {
    border-right: none;
    border-bottom: 1px solid #000;
  }
  .win-title {
    margin-right: 0;
  }
  .page {
    font-size: 0.78rem;
  }
  .board-tabs {
    gap: 10px;
  }
  .bt {
    font-size: 0.68rem;
  }
}
@media (max-width: 760px) {
  .lh {
    padding-top: 2.5rem;
  }
}
</style>
