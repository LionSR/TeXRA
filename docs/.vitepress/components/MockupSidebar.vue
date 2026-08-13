<script setup>
// TeXRA sidebar on the Progress tab — the orchestrator (a tool-use agent)
// delegating. `view` is shared with the parent so clicking a tool-use row or
// the latexdiff result switches the editor pane on the right.
const view = defineModel('view', { type: String, default: 'diff' });
</script>

<template>
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
        ><wa-icon class="sh-pulse" library="texra" name="pulse"></wa-icon>3
        turns, 12 tool calls</span
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
          <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
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
          <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
          Background Tasks
        </div>
        <div class="panel-body">
          <div class="sec-label">
            <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
            Subagents · 1 active · 1 done
          </div>
          <div class="task">
            <wa-icon class="task-ic" library="texra" name="robot"></wa-icon>
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
              <wa-icon class="umsg-ic" library="texra" name="comment"></wa-icon>
              <span class="umsg-time">11:13:50</span>
            </div>
            <div class="umsg-body">
              Derive the spectral-gap bound for d-regular random graphs,
              cross-check it numerically, and tighten the notation in §2–3.
            </div>
          </div>
        </div>

        <div class="reason">
          I'll hand the derivation and its checks to a research agent, then have
          the correct workflow tighten the prose and return a diff.
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
              <span class="tc-k">Agent</span><code class="tc-code">correct</code
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
            <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
            <wa-icon class="ldiff-ic" library="texra" name="diff"></wa-icon>
            <span class="ldiff-lbl">Latexdiff result</span>
          </summary>
          <div class="ldiff-row">
            <wa-icon class="ldiff-ok" library="texra" name="check"></wa-icon>
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
</template>

<style scoped>
/* Window chrome, sidebar shell, and the Progress-board primitives come from
   MockupFrame + theme/mockup.css; this file adds only the parts unique to the
   landing sidebar: background-task item, latexdiff result, and the in-progress
   spinner. */
.board {
  width: 340px;
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

/* Background task item */
.task {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}
.task-ic {
  display: inline-flex;
  color: var(--mk-syn-fn);
  flex-shrink: 0;
  font-size: 13px;
}
.task-name {
  color: var(--mk-text-dim);
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

/* In-progress (warning) spinner on the active delegation card */
.tc-sp {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid rgba(215, 169, 62, 0.3);
  border-top-color: var(--color-warning);
  border-radius: 50%;
  animation: mk-spin 0.9s linear infinite;
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
  color: var(--mk-accent);
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
.ldiff-link {
  color: var(--color-text-link);
  cursor: pointer;
}
.ldiff-file:hover,
.ldiff-link:hover {
  text-decoration: underline;
}

@media (max-width: 820px) {
  .board-tabs {
    gap: 10px;
  }
  .bt {
    font-size: 0.68rem;
  }
}
</style>
