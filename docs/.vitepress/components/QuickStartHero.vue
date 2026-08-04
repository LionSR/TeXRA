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
              <span class="s-val">sonnet5</span>
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
/* Launcher chrome (lpanel/prompt/footer/run/…) lives in mockup.css, shared
   with ToolConfigHero. Only the sidebar width is unique to this hero. */
.board {
  width: var(--mk-size-320);
}
</style>
