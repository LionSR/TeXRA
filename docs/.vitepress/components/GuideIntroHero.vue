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
        <span class="goal-chip"
          ><wa-icon class="goal-ic" library="texra" name="compass"></wa-icon
          >Goal</span
        >
        <span class="sh-badge">4 turns, 18 tool calls</span>
        <span class="sh-tools">
          <wa-icon class="shi" library="texra" name="circle-stop"></wa-icon>
          <wa-icon
            class="shi"
            library="texra"
            name="clock-rotate-left"
          ></wa-icon>
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
            <wa-icon class="tc-ic" library="texra" name="circle-user"></wa-icon>
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
            <wa-icon class="tc-ic" library="texra" name="circle-user"></wa-icon>
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
            <div class="tcard-sum">
              <wa-icon
                class="chev tc-chev open"
                library="texra"
                name="chevron-right"
              ></wa-icon>
              <wa-icon
                class="tc-ic"
                library="texra"
                name="circle-user"
              ></wa-icon>
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
  width: min(var(--mk-size-256), 100%);
}
/* This hero's header carries an extra Goal chip on top of the shared
   name/badge/tools, which overflows the 256px sidebar. Let it wrap to a second
   line instead of clipping (the shared .stream-head is nowrap + overflow:hidden,
   sized for MockupSidebar's wider board). */
.stream-head {
  flex-wrap: wrap;
  white-space: normal;
  height: auto;
  row-gap: var(--mk-space-4);
  min-width: 0;
  overflow: hidden;
}
.stream-head .sh-name {
  flex: 1 1 auto;
}
.stream-head .sh-badge {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stream-head .sh-tools {
  margin-left: auto;
}
.board-tabs,
.tcard,
.tcard-sum,
.tc-row,
.todo {
  min-width: 0;
}
.bt,
.tc-v,
.td-tx {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tc-v {
  overflow-wrap: anywhere;
}
/* Three editor tabs are tight at content width — shrink them to fit. */
.tabs .tab {
  font-size: var(--mk-fs-69);
  padding: var(--mk-space-8) var(--mk-space-8);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Orchestrator Goal chip (header) */
.goal-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-66);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-accent) 30%, transparent);
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-7);
  flex: 0 1 auto;
  min-width: 0;
}
.goal-ic {
  font-size: var(--mk-space-10);
}

/* BibTeX result (search pane) — the rest of the terminal surface comes from
   theme/mockup.css. */
.bib {
  margin-top: var(--mk-space-4);
}
.bl {
  white-space: pre-wrap;
}
.bl.indent {
  padding-left: var(--mk-space-1-4em);
}
.bk {
  color: var(--mk-syn-keyword);
}
.bid {
  color: var(--mk-syn-var);
}
.bok {
  display: inline-flex;
  color: var(--color-success);
  font-size: var(--mk-space-11);
  vertical-align: middle;
}
</style>
