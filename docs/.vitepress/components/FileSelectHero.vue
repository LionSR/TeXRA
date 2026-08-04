<script setup>
// File Management product slice: the Launcher's file-selection section with the
// real Input / Context / Media groups (FILE_SELECT_CONFIGS in store.ts). Each
// group is an ordered list with three header actions — Add opened files, Clear
// all, Add files.
import MockupFrame from './MockupFrame.vue';
</script>

<template>
  <MockupFrame title="draft.tex — texra-paper">
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

        <!-- Input -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon
                class="lbl-ic"
                library="texra"
                name="file-code"
              ></wa-icon>
              Input
              <span class="act" title="Tool configuration options"
                ><wa-icon library="texra" name="screwdriver-wrench"></wa-icon
              ></span>
            </span>
            <div class="acts">
              <span class="act" title="Add opened files as input"
                ><wa-icon library="texra" name="folder-open"></wa-icon
              ></span>
              <span class="act" title="Clear all input files"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
              <span class="act" title="Add input files"
                ><wa-icon library="texra" name="plus"></wa-icon
              ></span>
            </div>
          </div>
          <div class="flist">
            <div class="fitem">
              <!-- Decorative only: the real UI has no grip handle; the whole
                   row is draggable to reorder. -->
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

        <!-- Context -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon class="lbl-ic" library="texra" name="book"></wa-icon>
              Context</span
            >
            <div class="acts">
              <span class="act" title="Add opened files as context"
                ><wa-icon library="texra" name="folder-open"></wa-icon
              ></span>
              <span class="act" title="Clear all context files"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
              <span class="act" title="Add context files"
                ><wa-icon library="texra" name="plus"></wa-icon
              ></span>
            </div>
          </div>
          <div class="flist">
            <div class="fitem">
              <wa-icon
                class="fi-grip"
                library="texra"
                name="ellipsis"
              ></wa-icon>
              <span class="fi-name">references.bib</span>
              <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
            </div>
            <div class="fitem">
              <wa-icon
                class="fi-grip"
                library="texra"
                name="ellipsis"
              ></wa-icon>
              <span class="fi-name">preamble.sty</span>
              <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
            </div>
          </div>
        </div>

        <!-- Media -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon class="lbl-ic" library="texra" name="video"></wa-icon>
              Media
              <span class="act" title="Auto-extract options"
                ><wa-icon library="texra" name="wand-magic-sparkles"></wa-icon
              ></span>
            </span>
            <div class="acts">
              <span class="act" title="Add opened files as media"
                ><wa-icon library="texra" name="folder-open"></wa-icon
              ></span>
              <span class="act" title="Clear all media files"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
              <span class="act" title="Add media files"
                ><wa-icon library="texra" name="plus"></wa-icon
              ></span>
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

    <!-- Editor: the selected input document -->
    <div class="result">
      <div class="tabs">
        <button type="button" class="tab active">
          <wa-icon class="t-ic t-tex" library="texra" name="file-code"></wa-icon
          >draft.tex
        </button>
      </div>
      <div class="surface">
        <div class="cl"><span class="kw">\documentclass</span>{article}</div>
        <div class="cl">
          <span class="kw">\usepackage</span>{preamble}
          <span class="cmt">% from Context</span>
        </div>
        <div class="cl"><span class="kw">\begin</span>{document}</div>
        <div class="cl indent">
          <span class="kw">\input</span>{sections/intro}
        </div>
        <div class="cl indent">
          <span class="kw">\includegraphics</span>{figure1.pdf}
          <span class="cmt">% from Media</span>
        </div>
        <div class="cl indent">
          <span class="kw">\bibliography</span>{references}
          <span class="cmt">% from Context</span>
        </div>
        <div class="cl"><span class="kw">\end</span>{document}</div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
/* File-selector vocabulary (.files/.flist/.fitem/.fi-*) lives in mockup.css,
   shared with ToolConfigHero. Only the sidebar width is unique here. */
.board {
  width: var(--mk-size-320);
}
</style>
