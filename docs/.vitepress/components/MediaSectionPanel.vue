<script setup>
// Frameless slice of the Launcher's Media file group (FILE_SELECT_CONFIGS in
// store.ts), lifted out of FileSelectHero's MockupFrame so the figure focuses
// on just the Media surface: the uppercase MEDIA label with its inline wand
// "Auto-extract options" button, the right-aligned three-action toolbar (Add
// opened files / Clear all / Add media files), and the recessed ordered list
// of reorderable file rows (each with a decorative grip + trailing trash).
//
// Root carries `.mockup` so the shared file-selector vocabulary
// (.field/.frow/.acts/.act/.flist/.fitem/.f-label from theme/mockup.css) and
// the `--mk-*` tokens resolve here too, flipping cleanly with the docs theme.
//
// One row is shown in a faint hover/drag state to convey the reorder affordance.
const items = [
  { name: 'figure1.pdf' },
  { name: 'plot.png', dragging: true },
  { name: 'schematic.tikz' },
];
</script>

<template>
  <div class="mockup media-panel" role="group" aria-label="Media file group">
    <div class="field">
      <div class="frow">
        <span class="f-label">
          <wa-icon
            class="lbl-ic"
            library="texra"
            name="device-camera-video"
          ></wa-icon>
          Media
          <span class="act" title="Auto-extract options">
            <wa-icon library="texra" name="wand"></wa-icon>
          </span>
        </span>
        <div class="acts">
          <span class="act" title="Add opened files as media">
            <wa-icon library="texra" name="folder-opened"></wa-icon>
          </span>
          <span class="act" title="Clear all media files">
            <wa-icon library="texra" name="trash"></wa-icon>
          </span>
          <span class="act" title="Add media files">
            <wa-icon library="texra" name="add"></wa-icon>
          </span>
        </div>
      </div>

      <div class="flist">
        <div
          v-for="(f, i) in items"
          :key="i"
          class="fitem"
          :class="{ 'fitem--drag': f.dragging }"
        >
          <wa-icon class="fi-grip" library="texra" name="ellipsis"></wa-icon>
          <span class="fi-name">{{ f.name }}</span>
          <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. The .field/.frow/.acts/.act/.flist/.fitem/.f-label
   vocabulary lives on `.mockup` in theme/mockup.css; only the card shell and
   the drag-hover accent are unique here. */
.media-panel {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  max-width: var(--mk-size-320);
}

/* The row being dragged to reorder: lifted with the accent ring. */
.fitem--drag {
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  outline: 1px dashed var(--mk-accent);
  cursor: grabbing;
}
.fitem--drag .fi-grip {
  cursor: grabbing;
  color: var(--mk-accent);
}
</style>
