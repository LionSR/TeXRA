<script setup>
// Tool Config product slice: the Launcher's instruction footer with its two
// per-run helper dropdowns open. Mirrors FileSelectGroup.ts — the "Tool
// configuration options" menu (screwdriver-wrench) carries Attach TeX Count;
// the "Auto-extract options" menu (wand) carries Figures / TikZ Figures /
// Compile Input PDF. Both trigger buttons light up (has-options) while a
// helper is enabled.
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
        <div class="prompt">
          Improve the clarity and flow of this document; keep my notation.
        </div>

        <!-- Instruction footer: agent + model selects, then the two helper
             dropdown buttons, then Run. -->
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

          <div class="toolbar">
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
        <div class="menus">
          <div class="menu">
            <div class="menu-head">
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
            <div class="menu-head">
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
          With <b>Attach TeX Count</b> on, this summary is fed to the agent so it
          knows the document's size and structure before it edits.
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
.prompt {
  min-height: 60px;
  background: #181818;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  padding: 9px 10px;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--wa-color-text-normal);
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
.iact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  font-size: 14px;
}
.settings {
  flex-shrink: 0;
  color: #c89be0;
}

/* Helper-button row + Execute */
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.cfg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 5px;
  border: 1px solid var(--color-border);
  background: #2c2c2c;
  color: var(--color-text-secondary);
  font-size: 14px;
}
.cfg-btn.on {
  color: #c89be0;
  border-color: rgba(200, 155, 224, 0.55);
  background: rgba(200, 155, 224, 0.12);
}
.run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  flex: 1;
  border: none;
  border-radius: 6px;
  padding: 8px;
  background: #8957b5;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--vp-font-family-base);
}
.run wa-icon {
  font-size: 13px;
}

/* Open helper menus (popover cards) */
.menus {
  display: flex;
  gap: 8px;
}
.menu {
  flex: 1;
  background: #2a2a2a;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 5px;
  box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.6);
}
.menu-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 6px;
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 4px;
}
.menu-head wa-icon {
  font-size: 11px;
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
