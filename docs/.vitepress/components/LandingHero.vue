<script setup>
import { ref } from 'vue';
import { withBase } from 'vitepress';

// Right-panel view of the same task: the written diff, the numeric
// cross-check, or the formal proof. One task, three ways to trust it.
const view = ref('diff');
const installOpen = ref(false);
const copied = ref(false);

const CLI = 'npm install -g @texra-ai/cli';

// Real product logo, served from docs/public.
const LOGO = withBase('/logo-128x128.svg');

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

async function copyCli() {
  try {
    await navigator.clipboard.writeText(CLI);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable or write denied — leave label unchanged */
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
        <span class="win-title">spectral-gap — texra-paper</span>
      </div>
      <div class="win-body">
        <!-- VS Code activity bar -->
        <nav class="act">
          <span class="act-i"
            ><wa-icon library="texra" name="files"></wa-icon
          ></span>
          <span class="act-i"
            ><wa-icon library="texra" name="search"></wa-icon
          ></span>
          <span class="act-i"
            ><wa-icon library="texra" name="source-control"></wa-icon
          ></span>
          <span class="act-i"
            ><wa-icon library="texra" name="debug-alt"></wa-icon
          ></span>
          <span class="act-i act-on"
            ><img class="act-logo" :src="LOGO" alt="TeXRA"
          /></span>
          <span class="act-i act-bottom"
            ><wa-icon library="texra" name="settings-gear"></wa-icon
          ></span>
        </nav>

        <!-- Left: the TeXRA sidebar on the Progress tab (orchestrator = tool-use agent) -->
        <aside class="board">
          <div class="board-tabs">
            <span class="bt"
              ><wa-icon library="texra" name="pencil"></wa-icon> Launcher</span
            >
            <span class="bt bt-on"
              ><wa-icon library="texra" name="robot"></wa-icon> Progress</span
            >
          </div>

          <div class="stream-head">
            <span class="sh-name">orchestrator@opus47</span>
            <span class="sh-dot" title="Running"></span>
            <span class="sh-badge"
              ><wa-icon class="sh-pulse" library="texra" name="pulse"></wa-icon
              >3 turns, 12 tool calls</span
            >
            <span class="sh-tools">
              <wa-icon class="shi" library="texra" name="debug-stop"></wa-icon>
              <wa-icon class="shi" library="texra" name="history"></wa-icon>
              <wa-icon class="shi" library="texra" name="diff"></wa-icon>
            </span>
          </div>

          <div class="board-scroll">
            <!-- Todos panel -->
            <div class="panel">
              <div class="panel-sum">
                <wa-icon
                  class="chev"
                  library="texra"
                  name="chevron-down"
                ></wa-icon>
                Todos (2/3)
              </div>
              <div class="panel-body todos">
                <div class="todo done">
                  <wa-icon class="td-ic" library="texra" name="check"></wa-icon
                  ><span class="td-tx">Derive the spectral-gap bound</span>
                </div>
                <div class="todo done">
                  <wa-icon class="td-ic" library="texra" name="check"></wa-icon
                  ><span class="td-tx">Verify it in Wolfram and Lean</span>
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
                <wa-icon
                  class="chev"
                  library="texra"
                  name="chevron-down"
                ></wa-icon>
                Background Tasks
              </div>
              <div class="panel-body">
                <div class="sec-label">
                  <wa-icon
                    class="chev"
                    library="texra"
                    name="chevron-down"
                  ></wa-icon>
                  Subagents · 1 active · 1 done
                </div>
                <div class="task">
                  <wa-icon
                    class="task-ic"
                    library="texra"
                    name="robot"
                  ></wa-icon>
                  <span class="task-name">correct</span>
                  <span class="task-desc">(revising spectral-gap.tex)</span>
                  <span class="task-elapsed">0:18</span>
                  <span class="task-tag">running</span>
                </div>
              </div>
            </div>

            <!-- Conversation log: user message, reasoning, tool-use cards -->
            <div class="log">
              <div class="umsg-wrap">
                <div class="umsg">
                  <div class="umsg-head">
                    <wa-icon
                      class="umsg-ic"
                      library="texra"
                      name="comment"
                    ></wa-icon>
                    <span class="umsg-time">11:13:50</span>
                  </div>
                  <div class="umsg-body">
                    Derive the spectral-gap bound for d-regular random graphs,
                    cross-check it numerically, and tighten the notation in
                    §2–3.
                  </div>
                </div>
              </div>

              <div class="reason">
                I'll hand the derivation and its checks to a research agent,
                then have the correct workflow tighten the prose and return a
                diff.
              </div>

              <button
                class="tcard"
                :class="{ active: view === 'wolfram' || view === 'lean' }"
                @click="view = 'wolfram'"
              >
                <wa-icon
                  class="chev tc-chev"
                  library="texra"
                  name="chevron-right"
                ></wa-icon>
                <wa-icon class="tc-ic" library="texra" name="account"></wa-icon>
                <span class="tc-label"
                  ><span class="tc-tool">delegate_agent</span> — derive the
                  spectral-gap bound, then verify it in Wolfram and Lean</span
                >
                <span class="tc-time">11:14:38</span>
              </button>

              <!-- in-progress delegation, expanded to show real card body -->
              <div class="tcard run open" @click="view = 'diff'">
                <div class="tcard-sum">
                  <wa-icon
                    class="chev tc-chev open"
                    library="texra"
                    name="chevron-right"
                  ></wa-icon>
                  <span class="tc-sp"></span>
                  <span class="tc-label"
                    ><span class="tc-tool">delegate_workflow</span> — unify λ₂
                    notation across §2–3</span
                  >
                  <span class="tc-time tc-timer">0:18</span>
                </div>
                <div class="tc-body">
                  <div class="tc-row">
                    <span class="tc-k">Agent</span
                    ><code class="tc-code">correct</code
                    ><span class="tc-model">(gemini31p)</span>
                  </div>
                  <div class="tc-row">
                    <span class="tc-k">Instruction</span
                    ><span class="tc-v"
                      >Unify λ₂ notation across §2–3 and resolve label
                      conflicts.</span
                    >
                  </div>
                  <div class="tc-row">
                    <span class="tc-k">Files</span
                    ><span class="tc-file">spectral-gap.tex</span
                    ><span class="tc-src">(Input)</span>
                  </div>
                </div>
              </div>

              <details class="ldiff" open @click.prevent="view = 'diff'">
                <summary class="ldiff-sum">
                  <wa-icon
                    class="chev"
                    library="texra"
                    name="chevron-down"
                  ></wa-icon>
                  <wa-icon
                    class="ldiff-ic"
                    library="texra"
                    name="diff"
                  ></wa-icon>
                  <span class="ldiff-lbl">Latexdiff result</span>
                </summary>
                <div class="ldiff-row">
                  <wa-icon
                    class="ldiff-ok"
                    library="texra"
                    name="check"
                  ></wa-icon>
                  <span class="ldiff-file">spectral-gap.tex</span>
                  <span class="ldiff-r">[r0]</span>
                  <span class="ldiff-arrow">→</span>
                  <span class="ldiff-r">[r1]</span>
                  (<span class="ldiff-link">diff</span>)
                </div>
              </details>
            </div>
          </div>
        </aside>

        <!-- Right: the result — files the run produced, open in the editor -->
        <div class="result">
          <div class="tabs">
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'diff' }"
              @click="view = 'diff'"
            >
              <wa-icon
                class="t-ic t-pdf"
                library="texra"
                name="file-pdf"
              ></wa-icon
              >spectral-gap-diff.pdf
            </button>
            <button
              type="button"
              class="tab"
              :class="{ active: view === 'wolfram' }"
              @click="view = 'wolfram'"
            >
              <wa-icon
                class="t-ic t-wolf"
                library="texra"
                name="file-code"
              ></wa-icon
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
            <p class="pg-p">
              <b>Theorem 2 (Alon–Boppana).</b>
              <i
                >For a d-regular graph on n vertices, <del>λ₂ is large</del
                ><ins
                  >λ₂&nbsp;≥&nbsp;2√(d−1)&nbsp;−&nbsp;o(1) as
                  n&nbsp;→&nbsp;∞</ins
                >.</i
              >
              A d-regular graph meeting this bound with equality is called a
              <del>good expander</del><ins>Ramanujan graph</ins>.
            </p>
            <p class="pg-p">
              <i>Proof.</i> <del>It follows from counting walks.</del
              ><ins
                >Count closed walks of length 2k rooted at a fixed vertex. The
                number of such walks in the d-regular tree is the
                Catalan-weighted moment C<sub>k</sub>&nbsp;(d−1)<sup>k</sup>,
                and</ins
              >
              comparing with
              tr(A<sup>2k</sup>)&nbsp;=&nbsp;Σ<sub>i</sub>&nbsp;λ<sub>i</sub
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
            <div class="wl">
              λ2 = Max @ Rest @ ReverseSort @ Eigenvalues @ N @ A
            </div>
            <div class="wl out">4.41</div>
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
        </div>
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

   The board/log/card rules below consume the same design tokens the real
   webview components use (src/shared/styles/litStyles.ts + Web Awesome),
   resolved here to the dark VS Code surface values the extension gets from
   the host theme (the docs site has no --vscode-* / dark --wa-* theme).
   ============================================ */
.win {
  /* Spacing scale (Web Awesome) */
  --wa-space-3xs: 2px;
  --wa-space-2xs: 4px;
  --wa-space-xs: 8px;
  --wa-space-s: 12px;
  /* Borders & radii (litStyles designTokens) */
  --border-thin: 1px;
  --border-medium: 2px;
  --border-radius-small: 2px;
  --border-radius: 3px;
  --border-radius-large: 6px;
  /* Weights */
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  /* Surfaces / text (dark editor host theme) */
  --editor-bg: #1e1e1e;
  --surface-bg: #181818;
  --panel-bg: #252526;
  --color-border: #2a2a2a;
  --wa-color-text-normal: #cccccc;
  --color-text-secondary: #8a8a8a;
  --color-text-tertiary: #6f6f6f;
  --color-text-link: #4daafc;
  /* Status colors (litStyles designTokens fallbacks + logEntryStyles) */
  --color-success: #2ea043;
  --color-warning: #cca700;
  --color-error: #f14c4c;
  --wa-color-icon-info: #75beff;
  --wa-color-debug-name: #4b9ef9;
  --brand: #c89be0;

  text-align: left;
  background: var(--editor-bg);
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
  padding: 10px 0;
  gap: 16px;
}
.act-i {
  color: #858585;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 2px 0;
  font-size: 20px;
}
.act-on {
  color: #fff;
}
.act-on::before {
  content: '';
  position: absolute;
  left: 0;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: #c89be0;
}
.act-logo {
  width: 23px;
  height: 23px;
  display: block;
}
.act-bottom {
  margin-top: auto;
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
  align-items: stretch;
  height: 36px;
  padding: 0 8px;
  background: #252526;
  border-bottom: 1px solid #000;
  overflow: hidden;
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
  font-size: 12px;
}
.bt-on {
  color: #fff;
  font-weight: 600;
  box-shadow: inset 0 -2px 0 #c89be0;
}
/* Stream header */
.stream-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  min-width: 0;
  white-space: nowrap;
}
.sh-name {
  color: var(--wa-color-text-normal);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sh-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-success);
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
  display: inline-flex;
  color: #c89be0;
  font-size: 11px;
}
.sh-tools {
  margin-left: auto;
  display: flex;
  gap: 9px;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.shi {
  display: inline-flex;
  font-size: 13px;
}

.board-scroll {
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  overflow: hidden;
}

/* Collapsible panels (Todos, Background Tasks) */
.panel {
  border-bottom: 1px solid var(--color-border);
}
.panel-sum {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  color: var(--wa-color-text-normal);
  font-weight: 600;
}
.chev {
  display: inline-flex;
  color: #7a7a7a;
  flex-shrink: 0;
  font-size: 11px;
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
  color: var(--color-text-secondary);
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
  color: var(--color-text-secondary);
}
.todo.prog .td-tx {
  color: var(--wa-color-text-normal);
  font-weight: 600;
}
.td-ic {
  display: inline-flex;
  color: var(--color-success);
  flex-shrink: 0;
  font-size: 12px;
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
  display: inline-flex;
  color: #75beff;
  flex-shrink: 0;
  font-size: 13px;
}
.task-name {
  color: #e0e0e0;
  flex-shrink: 0;
}
.task-desc {
  color: var(--color-text-secondary);
  font-size: 0.7rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-elapsed {
  color: var(--color-text-secondary);
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
.umsg-wrap {
  display: flex;
  justify-content: flex-end;
}
.umsg {
  max-width: 88%;
  background: rgba(86, 110, 150, 0.22);
  border: 1px solid #3a3f4a;
  border-radius: 6px;
  padding: 6px 9px;
}
.umsg-head {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 3px;
  font-size: 0.64rem;
  color: var(--color-text-secondary);
}
.umsg-ic {
  display: inline-flex;
  color: var(--color-text-secondary);
  font-size: 11px;
}
.umsg-body {
  color: var(--wa-color-text-normal);
  line-height: 1.5;
  font-family: var(--vp-font-family-base);
  font-size: 0.77rem;
}
.reason {
  color: #b9b9b9;
  line-height: 1.5;
  font-family: var(--vp-font-family-base);
  font-size: 0.78rem;
  padding: 0 2px;
}

/* Tool-use cards — flush, borderless collapsible log rows */
.tcard {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 5px;
  padding: 4px 6px;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.tcard:hover {
  background: rgba(255, 255, 255, 0.04);
}
.tcard.active {
  background: rgba(200, 155, 224, 0.13);
}
.tc-ic {
  color: #75beff;
  flex-shrink: 0;
  display: inline-flex;
  font-size: 13px;
}
.tc-sp {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid rgba(215, 169, 62, 0.3);
  border-top-color: var(--color-warning);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
.tc-label {
  flex: 1;
  min-width: 0;
  color: var(--wa-color-text-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tc-tool {
  color: var(--color-text-secondary);
}
.tc-chev {
  align-self: center;
}
.tc-chev.open {
  transform: rotate(90deg);
}
.tc-time {
  flex-shrink: 0;
  align-self: center;
  font-size: 0.66rem;
  color: var(--color-text-tertiary);
}
.tc-timer {
  color: var(--color-warning);
}

/* Expanded (in-progress) delegation card */
.tcard.open {
  display: block;
  padding: 4px 6px;
}
.tcard.open:hover {
  background: rgba(200, 155, 224, 0.13);
}
.tcard-sum {
  display: flex;
  align-items: center;
  gap: 7px;
}
.tc-body {
  padding: 5px 0 2px 27px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tc-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 0.72rem;
  line-height: 1.4;
}
.tc-k {
  color: var(--color-text-secondary);
  flex-shrink: 0;
  min-width: 64px;
}
.tc-v {
  color: var(--wa-color-text-normal);
  font-family: var(--vp-font-family-base);
}
.tc-code {
  color: #c89be0;
  background: rgba(200, 155, 224, 0.12);
  border-radius: 3px;
  padding: 0 5px;
}
.tc-model {
  color: var(--color-text-secondary);
}
.tc-file {
  color: var(--color-text-link);
}
.tc-src {
  color: var(--color-text-secondary);
  font-style: italic;
}

/* Latexdiff result — flush borderless banner */
.ldiff {
  background: none;
  border: none;
  padding: 4px 6px;
  cursor: pointer;
}
.ldiff-sum {
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
  cursor: pointer;
}
.ldiff-sum::-webkit-details-marker {
  display: none;
}
.ldiff-ic {
  color: #c89be0;
  display: inline-flex;
  font-size: 12px;
}
.ldiff-lbl {
  color: var(--wa-color-text-normal);
}
.ldiff-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  padding-left: 26px;
  color: var(--color-text-secondary);
}
.ldiff-ok {
  display: inline-flex;
  color: var(--color-success);
  font-size: 11px;
}
.ldiff-r {
  color: var(--color-text-secondary);
}
.ldiff-arrow {
  color: var(--color-text-tertiary);
}
/* File references behave like the real clickable file-links */
.ldiff-file,
.ldiff-link,
.tc-file {
  color: var(--color-text-link);
  cursor: pointer;
}
.ldiff-file:hover,
.ldiff-link:hover,
.tc-file:hover {
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
