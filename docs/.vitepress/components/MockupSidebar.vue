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
/* Design tokens (--wa-space-*, --color-*, --brand, …) are defined on .win in
   LandingHero.vue and inherit into this component's DOM. */
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

@media (max-width: 820px) {
  .board {
    border-right: none;
    border-bottom: 1px solid #000;
  }
  .board-tabs {
    gap: 10px;
  }
  .bt {
    font-size: 0.68rem;
  }
}
</style>
