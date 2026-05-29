<script setup>
// Tool Config product slice: the Launcher's instruction footer with its two
// per-run helper dropdowns open. Mirrors FileSelectGroup.ts — the "Tool
// configuration options" menu (tools) carries Attach TeX Count; the
// "Auto-extract options" menu (wand) carries Figures / TikZ Figures / Compile
// Input PDF. Both trigger buttons light up while a helper is enabled.
//
// Reuses the shared launcher chrome (.lpanel/.footer/.sgroup/.settings/.run
// from mockup.css); only the helper buttons + open menus are unique here.
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

          <!-- Helper buttons + Execute. Both helpers active → buttons lit. -->
          <div class="sgroup">
            <span class="cfg-btn on" title="Tool configuration options"
              ><wa-icon library="texra" name="tools"></wa-icon
            ></span>
            <span class="cfg-btn on" title="Auto-extract options"
              ><wa-icon library="texra" name="sparkle"></wa-icon
            ></span>
            <button class="run">
              <wa-icon library="texra" name="play"></wa-icon
              ><span class="run-lbl">Execute</span>
            </button>
          </div>
        </div>

        <!-- The two open helper menus, focused on this step. -->
        <div class="menu">
          <div class="f-label">
            <wa-icon library="texra" name="tools"></wa-icon> Tool config
          </div>
          <div class="opt on">
            <span class="ckbox"
              ><wa-icon library="texra" name="check"></wa-icon
            ></span>
            Attach TeX Count
          </div>
        </div>

        <div class="menu">
          <div class="f-label">
            <wa-icon library="texra" name="sparkle"></wa-icon> Auto-extract
          </div>
          <div class="opt on">
            <span class="ckbox"
              ><wa-icon library="texra" name="check"></wa-icon
            ></span>
            Figures
          </div>
          <div class="opt">
            <span class="ckbox"></span>
            TikZ Figures
          </div>
          <div class="opt">
            <span class="ckbox"></span>
            Compile Input PDF
          </div>
        </div>
      </div>
    </aside>

    <!-- Editor: TeX Count attaches a word-count summary to the run. -->
    <div class="result">
      <div class="tabs">
        <button type="button" class="tab active">
          <wa-icon class="t-ic t-tex" library="texra" name="file-code"></wa-icon
          >draft.tex
        </button>
      </div>
      <div class="term">
        <div class="wl"><span class="tac">$</span> texcount draft.tex</div>
        <div class="wl out">Words in text: 1842</div>
        <div class="wl out">Words in headers: 24</div>
        <div class="wl out">Words outside text (captions, etc.): 96</div>
        <div class="wl out">Number of floats/tables/figures: 3</div>
        <div class="term-note">
          With <b>Attach TeX Count</b> on, this summary is fed to the agent so
          it knows the document's size and structure before it edits.
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
.board {
  width: 320px;
}

/* Helper trigger buttons (lit when a helper is on) — the only footer-control
   variant unique to this slice; the rest of the footer is shared chrome. */
.cfg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 5px;
  border: 1px solid rgba(200, 155, 224, 0.55);
  background: rgba(200, 155, 224, 0.12);
  color: #c89be0;
  font-size: 14px;
}
/* Execute shares .run but sits inline with the helper buttons here. */
.sgroup .run {
  flex: 1;
  width: auto;
  margin-top: 0;
  padding: 7px;
  font-size: 0.82rem;
}

/* Open dropdown menu (checkbox list). Reuses .f-label for the header. */
.menu {
  background: #2a2a2a;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 6px;
  box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.6);
}
.menu .f-label {
  padding: 2px 4px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
}
.menu .f-label wa-icon {
  color: #c89be0;
}
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 4px;
  font-size: 0.78rem;
  color: var(--wa-color-text-normal);
}
.opt.on {
  background: rgba(200, 155, 224, 0.1);
}
.ckbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  border: 1px solid #5a5a5a;
  border-radius: 3px;
  background: #1e1e1e;
  font-size: 9px;
  color: transparent;
}
.opt.on .ckbox {
  background: #8957b5;
  border-color: #8957b5;
  color: #fff;
}
</style>
