<script setup>
// Quick Start product slice: the Launcher tab as you'd fill it in for a first
// run — input file, agent, model, instruction, Execute — beside the open .tex.
import MockupFrame from './MockupFrame.vue';
</script>

<template>
  <MockupFrame title="draft.tex — texra-sample">
    <aside class="board">
      <div class="board-tabs">
        <span class="bt bt-on"
          ><wa-icon library="texra" name="pencil"></wa-icon> Launcher</span
        >
        <span class="bt"
          ><wa-icon library="texra" name="robot"></wa-icon> Progress</span
        >
      </div>

      <div class="launch">
        <div class="field">
          <span class="f-label">Input</span>
          <div class="f-row">
            <span class="chip chip-file"
              ><wa-icon library="texra" name="file-code"></wa-icon
              >draft.tex</span
            >
            <span class="chip chip-cur">Current</span>
          </div>
        </div>

        <div class="field">
          <span class="f-label">Agent</span>
          <div class="select">
            <wa-icon class="s-ic" library="texra" name="robot"></wa-icon>
            <span class="s-val">polish</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>

        <div class="field">
          <span class="f-label">Model</span>
          <div class="select">
            <wa-icon class="s-ic" library="texra" name="sparkle"></wa-icon>
            <span class="s-val">sonnet46</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>

        <div class="field f-grow">
          <span class="f-label">Instruction</span>
          <div class="prompt">
            Tighten the abstract and fix the awkward phrasing in §2 — keep my
            notation.<span class="caret-blink"></span>
          </div>
        </div>

        <button class="exec">
          <wa-icon library="texra" name="play"></wa-icon> Execute
        </button>
      </div>
    </aside>

    <!-- Editor: the document being worked on -->
    <div class="result">
      <div class="tabs">
        <button type="button" class="tab active">
          <wa-icon class="t-ic t-tex" library="texra" name="file-code"></wa-icon
          >draft.tex
        </button>
      </div>
      <div class="code">
        <div class="cl">
          <span class="g">% sample project — run polish on me</span>
        </div>
        <div class="cl"><span class="kw">\begin</span>{abstract}</div>
        <div class="cl indent">
          We present a novel and efficient method for the
        </div>
        <div class="cl indent">
          estimation of spectral gaps in random regular
        </div>
        <div class="cl indent">graphs, that is both fast and accurate.</div>
        <div class="cl"><span class="kw">\end</span>{abstract}</div>
        <div class="cl"></div>
        <div class="cl"><span class="kw">\section</span>{Preliminaries}</div>
        <div class="cl indent">
          Let <span class="m">$G$</span> be a <span class="m">$d$</span>-regular
          graph on <span class="m">$n$</span> vertices.
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
.board {
  flex-shrink: 0;
  width: 320px;
  background: #1e1e1e;
  border-right: 1px solid #000;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.board-tabs {
  display: flex;
  height: 36px;
  padding: 0 8px;
  background: #252526;
  border-bottom: 1px solid #000;
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

.launch {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 12px;
  flex: 1;
  font-family: var(--vp-font-family-base);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.f-grow {
  flex: 1;
}
.f-label {
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}
.f-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.76rem;
  border-radius: 4px;
  padding: 3px 8px;
}
.chip wa-icon {
  font-size: 12px;
}
.chip-file {
  color: var(--color-text-link);
  background: rgba(77, 170, 252, 0.1);
}
.chip-cur {
  color: var(--color-text-secondary);
  background: #2c2c2c;
  border: 1px solid var(--color-border);
}
.select {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #2c2c2c;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  padding: 6px 9px;
  font-size: 0.8rem;
  color: var(--wa-color-text-normal);
}
.s-ic {
  font-size: 13px;
  color: #c89be0;
}
.s-val {
  font-family: var(--vp-font-family-mono);
}
.s-caret {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.prompt {
  flex: 1;
  min-height: 84px;
  background: #181818;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  padding: 9px 10px;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--wa-color-text-normal);
}
.caret-blink {
  display: inline-block;
  width: 1px;
  height: 1em;
  margin-left: 1px;
  background: #c89be0;
  vertical-align: text-bottom;
  animation: blink 1.1s step-end infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.exec {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  border: none;
  border-radius: 6px;
  padding: 9px;
  background: #8957b5;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--vp-font-family-base);
}
.exec wa-icon {
  font-size: 13px;
}

/* Editor */
.result {
  display: flex;
  flex-direction: column;
  flex: 1;
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
  font-size: 0.74rem;
  padding: 8px 14px;
  cursor: default;
  font-family: var(--vp-font-family-mono);
}
.tab.active {
  background: #1e1e1e;
  color: #fff;
  box-shadow: inset 0 2px 0 #c89be0;
}
.t-ic {
  display: inline-flex;
  flex-shrink: 0;
  font-size: 12px;
}
.t-tex {
  color: #4daafc;
}
.code {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 14px 18px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.75;
  color: var(--wa-color-text-normal);
}
.cl {
  white-space: pre-wrap;
  min-height: 1.4em;
}
.cl.indent {
  padding-left: 1.4em;
}
.g {
  color: #6a9955;
}
.kw {
  color: #c586c0;
}
.m {
  color: #9cdcfe;
}

@media (max-width: 820px) {
  .board {
    width: auto;
    border-right: none;
    border-bottom: 1px solid #000;
  }
}
</style>
