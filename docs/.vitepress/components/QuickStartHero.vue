<script setup>
// Quick Start product slice: the Launcher panel as you'd fill it for a first
// run — session type, an instruction, an agent + model, and Run — beside the
// open .tex. Mirrors InstructionPanel.ts (session toggle, header actions,
// instruction textarea, model-selection footer, brand "Run" button).
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

      <div class="lpanel">
        <div class="phead">
          <div class="seg">
            <span class="seg-opt">Interactive</span>
            <span class="seg-opt seg-on">Workflow</span>
          </div>
          <div class="hactions">
            <span class="iact" title="Polish instruction"
              ><wa-icon library="texra" name="sparkle"></wa-icon
            ></span>
            <span class="iact" title="Record instruction"
              ><wa-icon library="texra" name="mic"></wa-icon
            ></span>
            <span class="iact" title="Erase instruction"
              ><wa-icon library="texra" name="clear-all"></wa-icon
            ></span>
          </div>
        </div>

        <div class="prompt">
          Tighten the abstract and fix the awkward phrasing in §2 — keep my
          notation.<span class="caret-blink"></span>
        </div>

        <div class="footer">
          <div class="sgroup">
            <span class="iact settings" title="Agent settings"
              ><wa-icon library="texra" name="sparkle"></wa-icon
            ></span>
            <div class="select">
              <span class="s-val">polish</span>
              <wa-icon
                class="s-caret"
                library="texra"
                name="chevron-down"
              ></wa-icon>
            </div>
          </div>
          <div class="sgroup">
            <span class="iact settings" title="Model settings"
              ><wa-icon library="texra" name="robot"></wa-icon
            ></span>
            <div class="select">
              <span class="s-val">sonnet46</span>
              <wa-icon
                class="s-caret"
                library="texra"
                name="chevron-down"
              ></wa-icon>
            </div>
          </div>
          <button class="run">
            <wa-icon library="texra" name="play"></wa-icon
            ><span class="run-lbl">Run</span>
          </button>
        </div>
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
      <div class="surface">
        <div class="cl"><span class="cmt">% sample project</span></div>
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
  width: 320px;
}
.lpanel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  flex: 1;
  font-family: var(--vp-font-family-base);
}
.phead {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Session-type segmented toggle */
.seg {
  display: inline-flex;
  background: #2c2c2c;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 2px;
  font-size: 0.72rem;
}
.seg-opt {
  padding: 3px 9px;
  border-radius: 4px;
  color: var(--color-text-secondary);
}
.seg-on {
  background: #3a3a3a;
  color: #fff;
  font-weight: 600;
}
.hactions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.iact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  color: var(--color-text-secondary);
  font-size: 14px;
}
.iact:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--wa-color-text-normal);
}

.prompt {
  flex: 1;
  min-height: 120px;
  background: #181818;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  padding: 9px 10px;
  font-size: 0.82rem;
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
  animation: mk-blink 1.1s step-end infinite;
}

.footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sgroup {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sgroup .select {
  flex: 1;
}
.settings {
  flex-shrink: 0;
  color: #c89be0;
}
.run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  border: none;
  border-radius: 6px;
  padding: 9px;
  margin-top: 2px;
  background: #8957b5;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--vp-font-family-base);
}
.run wa-icon {
  font-size: 13px;
}
</style>
