<script setup>
// Docs front-door product slice: the orchestrator (a tool-use agent) has
// delegated one task to a team of specialists. Clicking a delegation row in
// the Progress sidebar switches the editor to that specialist's artifact —
// grounded literature search, a Wolfram cross-check, a Lean 4 proof.
// Mirrors StreamHeader.ts, TodoList.ts, BackgroundTasksPanel.ts, and the
// delegate_agent tool-use card from toolFormatters.ts.
import { ref } from 'vue';
import MockupFrame from './MockupFrame.vue';

const view = ref('search');
</script>

<template>
  <MockupFrame title="entanglement-paper — texra" class="tall">
    <!-- Progress sidebar: orchestrator + specialist roster -->
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
        <span class="sh-name">orchestrator</span>
        <span class="sh-dot" title="Running"></span>
        <span class="odyssey"
          ><wa-icon class="ody-ic" library="texra" name="compass"></wa-icon
          >Odyssey</span
        >
        <span class="sh-badge"
          ><wa-icon class="sh-pulse" library="texra" name="pulse"></wa-icon>4
          turns, 18 tool calls</span
        >
        <span class="sh-tools">
          <wa-icon class="shi" library="texra" name="debug-stop"></wa-icon>
          <wa-icon class="shi" library="texra" name="history"></wa-icon>
        </span>
      </div>

      <div class="board-scroll">
        <div class="panel">
          <div class="panel-sum">
            <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
            Todos (2/3)
          </div>
          <div class="panel-body todos">
            <div class="todo done">
              <wa-icon class="td-ic" library="texra" name="check"></wa-icon
              ><span class="td-tx">Ground the literature</span>
            </div>
            <div class="todo done">
              <wa-icon class="td-ic" library="texra" name="check"></wa-icon
              ><span class="td-tx">Derive the concurrence</span>
            </div>
            <div class="todo prog">
              <span class="td-sp"></span
              ><span class="td-tx">Formalize subadditivity in Lean</span>
            </div>
          </div>
        </div>

        <div class="log">
          <div class="umsg-wrap">
            <div class="umsg">
              <div class="umsg-head">
                <wa-icon
                  class="umsg-ic"
                  library="texra"
                  name="comment"
                ></wa-icon>
                <span class="umsg-time">09:02:11</span>
              </div>
              <div class="umsg-body">
                Survey steady-state entanglement, derive the concurrence, and
                formalize the entropy bound.
              </div>
            </div>
          </div>

          <div class="reason">
            I'll split this across three specialists and assemble their results.
          </div>

          <button
            class="tcard"
            :class="{ active: view === 'search' }"
            @click="view = 'search'"
          >
            <wa-icon
              class="chev tc-chev"
              library="texra"
              name="chevron-right"
            ></wa-icon>
            <wa-icon class="tc-ic" library="texra" name="account"></wa-icon>
            <span class="tc-label"
              ><span class="tc-tool">delegate_agent</span> — search · arXiv +
              Crossref</span
            >
            <span class="tc-time">0:31</span>
          </button>

          <button
            class="tcard"
            :class="{ active: view === 'wolfram' }"
            @click="view = 'wolfram'"
          >
            <wa-icon
              class="chev tc-chev"
              library="texra"
              name="chevron-right"
            ></wa-icon>
            <wa-icon class="tc-ic" library="texra" name="account"></wa-icon>
            <span class="tc-label"
              ><span class="tc-tool">delegate_agent</span> — research · derive
              in Wolfram</span
            >
            <span class="tc-time">1:12</span>
          </button>

          <!-- active delegation, expanded to show the real card body -->
          <div
            class="tcard open"
            :class="{ active: view === 'lean' }"
            @click="view = 'lean'"
          >
            <div class="tc-sum">
              <wa-icon
                class="chev tc-chev tc-open"
                library="texra"
                name="chevron-right"
              ></wa-icon>
              <wa-icon class="tc-ic" library="texra" name="account"></wa-icon>
              <span class="tc-label"
                ><span class="tc-tool">delegate_agent</span> — lean</span
              >
              <span class="tc-time tc-timer">0:24</span>
            </div>
            <div class="tc-body">
              <div class="tc-row">
                <span class="tc-k">Agent</span><code class="tc-code">lean</code
                ><span class="tc-model">(opus47T)</span>
              </div>
              <div class="tc-row">
                <span class="tc-k">Instruction</span
                ><span class="tc-v"
                  >Formalize subadditivity of the von Neumann entropy.</span
                >
              </div>
              <div class="tc-row">
                <span class="tc-k">Files</span
                ><span class="tc-file">Entropy.lean</span
                ><span class="tc-src">(input)</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- Editor: the active specialist's artifact -->
    <div class="result">
      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ active: view === 'search' }"
          @click="view = 'search'"
        >
          <wa-icon class="t-ic t-bib" library="texra" name="book"></wa-icon
          >references.bib
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
          >concurrence.wls
        </button>
        <button
          type="button"
          class="tab"
          :class="{ active: view === 'lean' }"
          @click="view = 'lean'"
        >
          <span class="t-ic t-lean">λ</span>Entropy.lean
        </button>
      </div>

      <!-- search: grounded BibTeX -->
      <div v-show="view === 'search'" class="term">
        <div class="cmt">% 3 references found · DOIs verified via Crossref</div>
        <div class="bib">
          <div class="bl">
            <span class="bk">@article</span>{<span class="bid"
              >wolff2021steady</span
            >,
          </div>
          <div class="bl indent">
            title = {Steady-state entanglement in driven spin chains},
          </div>
          <div class="bl indent">author = {Wolff, S. and Kollath, C.},</div>
          <div class="bl indent">journal = {Phys. Rev. A}, year = {2021},</div>
          <div class="bl indent">
            doi = {10.1103/PhysRevA.103.022210}
            <wa-icon class="bok" library="texra" name="check"></wa-icon>
          </div>
          <div class="bl">}</div>
        </div>
        <div class="term-note">
          Every entry resolves to a real DOI — no fabricated citations.
          <span class="term-ok">✓ 3/3 verified</span>
        </div>
      </div>

      <!-- wolfram -->
      <div v-show="view === 'wolfram'" class="term">
        <div class="cmt">(* concurrence of the steady state, N = 2 *)</div>
        <div class="wl">rho = SteadyState[lindblad];</div>
        <div class="wl">C = Concurrence @ rho // FullSimplify</div>
        <div class="wl out">(γ² Sin[2θ]) / (γ² + 4Δ²)</div>
        <div class="term-note">
          Cross-checked against exact diagonalization at N = 8.
          <span class="term-ok">✓ agrees to 1e-9</span>
        </div>
      </div>

      <!-- lean -->
      <div v-show="view === 'lean'" class="term term-lean">
        <div class="ln">
          <span class="kw">theorem</span> entropy_subadditive
          <span class="kw">(ρ</span> : State H) :
        </div>
        <div class="ln indent">
          S (ptrace ρ) ≤ S ρ := <span class="kw">by</span>
        </div>
        <div class="ln indent2">
          <span class="tac">have</span> h := strong_subadditivity ρ
        </div>
        <div class="ln indent2"><span class="tac">linarith</span></div>
        <div class="term-note">
          <span class="term-ok"
            >⟳ checking proof state · Loogle found 1 lemma</span
          >
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
.board {
  width: 256px;
}
/* Three editor tabs are tight at content width — shrink them to fit. */
.tabs .tab {
  font-size: 0.69rem;
  padding: 8px 8px;
}

/* Stream header */
.stream-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  white-space: nowrap;
}
.sh-name {
  color: var(--wa-color-text-normal);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sh-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-success);
  flex-shrink: 0;
  animation: mk-shpulse 1.8s infinite;
}
.odyssey {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.66rem;
  color: #cda6e6;
  background: rgba(200, 155, 224, 0.12);
  border: 1px solid rgba(200, 155, 224, 0.3);
  border-radius: 999px;
  padding: 1px 7px;
  flex-shrink: 0;
}
.ody-ic {
  font-size: 10px;
}
.sh-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.66rem;
  color: #c89be0;
  background: rgba(200, 155, 224, 0.12);
  border-radius: 999px;
  padding: 1px 8px;
  flex-shrink: 0;
}
.sh-pulse {
  display: inline-flex;
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
.td-pending {
  color: var(--color-text-secondary) !important;
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
  animation: mk-spin 0.9s linear infinite;
}
.td-todo {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  border: 1.5px solid var(--color-text-tertiary);
  border-radius: 50%;
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

/* Tool-use / delegate cards */
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
.tc-open {
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

/* Expanded delegate card */
.tcard.open {
  display: block;
  padding: 4px 6px;
}
.tcard.open:hover {
  background: rgba(200, 155, 224, 0.13);
}
.tc-sum {
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
.tc-src {
  color: var(--color-text-secondary);
  font-style: italic;
}
.tc-file {
  color: var(--color-text-link);
}

/* BibTeX result (search pane) — the rest of the terminal surface comes from
   theme/mockup.css. */
.bib {
  margin-top: 4px;
}
.bl {
  white-space: pre-wrap;
}
.bl.indent {
  padding-left: 1.4em;
}
.bk {
  color: #c586c0;
}
.bid {
  color: #9cdcfe;
}
.bok {
  display: inline-flex;
  color: var(--color-success);
  font-size: 11px;
  vertical-align: middle;
}
</style>
