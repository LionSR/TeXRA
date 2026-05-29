<script setup>
// Tool Config product slice: the per-run helper menus that live in the file-
// group headers (FileSelectGroup.ts). The Input group carries the "Tool
// configuration options" button (tools) → Attach TeX Count; the Media group
// carries the "Auto-extract options" button (wand) → Figures / TikZ Figures /
// Compile Input PDF. Both buttons light up (has-options) while a helper is on,
// shown here with their wa-dropdown menus open.
//
// Reuses the shared file-selector vocabulary (.board/.field/.frow/.acts/.act/
// .flist/.fitem) and the open checkbox dropdown (.wa-menu/.wa-item/.wa-check),
// both from mockup.css; only the sidebar width and menu offset are unique here.
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
                ><wa-icon library="texra" name="wand"></wa-icon
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
/* File-selector vocabulary (.files/.flist/.fitem/.fi-*) and the open
   .wa-menu/.wa-item/.wa-check checkbox dropdown both live in mockup.css, shared
   with FileSelectHero. Only the sidebar width and the menu's offset under its
   trigger are unique here. */
.board {
  width: var(--mk-size-320);
}
.wa-menu {
  margin: var(--mk-space-2) 0 var(--mk-space-2) var(--mk-space-18);
}
</style>
