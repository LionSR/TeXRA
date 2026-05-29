<script setup>
// Tool Config product slice: the per-run helper menus that live in the file-
// group headers (FileSelectGroup.ts). The Input group carries the "Tool
// configuration options" button (tools) → Attach TeX Count; the Media group
// carries the "Auto-extract options" button (wand) → Figures / TikZ Figures /
// Compile Input PDF. Both buttons light up (has-options) while a helper is on,
// shown here with their wa-dropdown menus open.
//
// Reuses the shared file-selector vocabulary (.board/.field/.frow/.acts/.act/
// .flist/.fitem from mockup.css + FileSelectHero); only the open menus are
// unique here.
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

      <div class="files">
        <div class="sechead">
          <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
          <span class="sec-lbl">Files</span>
        </div>

        <!-- Input: carries the Tool config menu (Attach TeX Count). -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon
                class="lbl-ic"
                library="texra"
                name="file-code"
              ></wa-icon>
              Input
              <span class="act act-on" title="Tool configuration options"
                ><wa-icon library="texra" name="tools"></wa-icon
              ></span>
            </span>
            <div class="acts">
              <span class="act" title="Add opened files as input"
                ><wa-icon library="texra" name="folder-opened"></wa-icon
              ></span>
              <span class="act" title="Clear all input files"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
              <span class="act" title="Add input files"
                ><wa-icon library="texra" name="add"></wa-icon
              ></span>
            </div>
          </div>

          <!-- Open Tool config dropdown. -->
          <div class="wa-menu">
            <div class="wa-item checked">
              <span class="wa-check"
                ><wa-icon library="texra" name="check"></wa-icon
              ></span>
              Attach TeX Count
            </div>
          </div>

          <div class="flist">
            <div class="fitem">
              <wa-icon
                class="fi-grip"
                library="texra"
                name="ellipsis"
              ></wa-icon>
              <span class="fi-name">draft.tex</span>
              <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
            </div>
          </div>
        </div>

        <!-- Media: carries the Auto-extract menu. -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon
                class="lbl-ic"
                library="texra"
                name="device-camera-video"
              ></wa-icon>
              Media
              <span class="act act-on" title="Auto-extract options"
                ><wa-icon library="texra" name="sparkle"></wa-icon
              ></span>
            </span>
            <div class="acts">
              <span class="act" title="Add opened files as media"
                ><wa-icon library="texra" name="folder-opened"></wa-icon
              ></span>
              <span class="act" title="Clear all media files"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
              <span class="act" title="Add media files"
                ><wa-icon library="texra" name="add"></wa-icon
              ></span>
            </div>
          </div>

          <!-- Open Auto-extract dropdown. -->
          <div class="wa-menu">
            <div class="wa-item checked">
              <span class="wa-check"
                ><wa-icon library="texra" name="check"></wa-icon
              ></span>
              Figures
            </div>
            <div class="wa-item">
              <span class="wa-check"></span>
              TikZ Figures
            </div>
            <div class="wa-item">
              <span class="wa-check"></span>
              Compile Input PDF
            </div>
          </div>

          <div class="flist">
            <div class="fitem">
              <wa-icon
                class="fi-grip"
                library="texra"
                name="ellipsis"
              ></wa-icon>
              <span class="fi-name">figure1.pdf</span>
              <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- Editor: the document being prepared for the run. -->
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
          We present an efficient method for the estimation
        </div>
        <div class="cl indent">of spectral gaps in random regular graphs.</div>
        <div class="cl"><span class="kw">\end</span>{abstract}</div>
        <div class="cl"></div>
        <div class="cl"><span class="kw">\section</span>{Preliminaries}</div>
        <div class="cl indent">
          Let <span class="m">$G$</span> be a <span class="m">$d$</span>-regular
          graph.
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
.board {
  width: 320px;
}
.files {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  font-family: var(--vp-font-family-base);
}

/* The lit menu trigger sits inline with the group label. */
.f-label .act {
  margin-left: 2px;
}

/* wa-dropdown popover with checkbox items (mirrors wa-dropdown-item
   type="checkbox": a leading check that only shows when selected). */
.wa-menu {
  align-self: flex-start;
  min-width: 180px;
  margin: 2px 0 2px 18px;
  background: #2c2c2c;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.75);
}
.wa-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 6px;
  border-radius: 4px;
  font-size: 0.8rem;
  color: var(--wa-color-text-normal);
  white-space: nowrap;
}
.wa-item:hover {
  background: rgba(255, 255, 255, 0.07);
}
.wa-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  font-size: 11px;
  color: #c89be0;
  opacity: 0;
}
.wa-item.checked .wa-check {
  opacity: 1;
}
</style>
