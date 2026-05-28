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
              Input</span
            >
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

        <!-- Context -->
        <div class="field">
          <div class="frow">
            <span class="f-label"
              ><wa-icon class="lbl-ic" library="texra" name="book"></wa-icon>
              Context</span
            >
            <div class="acts">
              <span class="act" title="Add opened files as context"
                ><wa-icon library="texra" name="folder-opened"></wa-icon
              ></span>
              <span class="act" title="Clear all context files"
                ><wa-icon library="texra" name="trash"></wa-icon
              ></span>
              <span class="act" title="Add context files"
                ><wa-icon library="texra" name="add"></wa-icon
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
              ><wa-icon
                class="lbl-ic"
                library="texra"
                name="device-camera-video"
              ></wa-icon>
              Media</span
            >
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

/* Multiple-file list */
.flist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  background: #181818;
  border: 1px solid var(--color-border);
  border-radius: 5px;
}
.fitem {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 5px;
  border-radius: 4px;
  background: #2c2c2c;
}
.fi-grip {
  font-size: 11px;
  color: var(--color-text-tertiary);
  cursor: grab;
}
.fi-name {
  flex: 1;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  color: var(--color-text-link);
}
.fi-rm {
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.fi-rm:hover {
  color: var(--color-error);
}
</style>
