<script setup>
// Frameless slice of the Media group's "Auto-extract options" helper menu
// (FileSelectGroup.ts), lifted out of ToolConfigHero's MockupFrame so the
// figure focuses on just the auto-extract control: the MEDIA label row with
// its lit-up wand button (`act-on`), and directly below it the open checkbox
// dropdown popover with the three real options — Figures (checked), TikZ
// Figures, Compile Input PDF.
//
// Root carries `.mockup` so the shared file-selector vocabulary
// (.field/.frow/.act/.f-label from theme/mockup.css) resolves; the .wa-menu /
// .wa-item checkbox-dropdown styling mirrors ToolConfigHero's scoped CSS.
const options = [
  { label: 'Figures', checked: true },
  { label: 'TikZ Figures', checked: false },
  { label: 'Compile Input PDF', checked: false },
];
</script>

<template>
  <div class="mockup autoext" role="group" aria-label="Auto-extract options">
    <div class="field">
      <div class="frow">
        <span class="f-label">
          <wa-icon
            class="lbl-ic"
            library="texra"
            name="device-camera-video"
          ></wa-icon>
          Media
          <span class="act act-on" title="Auto-extract options">
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

      <!-- Open Auto-extract dropdown (wa-dropdown with checkbox items). -->
      <div class="wa-menu">
        <div
          v-for="(o, i) in options"
          :key="i"
          class="wa-item"
          :class="{ checked: o.checked }"
        >
          <span class="wa-check">
            <wa-icon v-if="o.checked" library="texra" name="check"></wa-icon>
          </span>
          {{ o.label }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. The .field/.frow/.act/.f-label vocabulary lives on
   `.mockup` in theme/mockup.css; the .wa-menu / .wa-item checkbox dropdown
   mirrors ToolConfigHero's scoped popover styling. */
.autoext {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  max-width: var(--mk-size-300);
}

/* wa-dropdown popover with checkbox items (mirrors wa-dropdown-item
   type="checkbox": a leading check that only shows when selected). */
.wa-menu {
  align-self: flex-start;
  min-width: var(--mk-size-180);
  margin: var(--mk-space-2) 0 0 var(--mk-space-18);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-4);
  box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.75);
}
.wa-item {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-5) var(--mk-space-12) var(--mk-space-5)
    var(--mk-space-6);
  border-radius: var(--mk-radius);
  font-size: var(--mk-fs-80);
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
  width: var(--mk-space-16);
  flex-shrink: 0;
  font-size: var(--mk-space-11);
  color: var(--mk-accent);
}
</style>
