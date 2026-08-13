<script setup>
// Frameless Launcher instruction-panel header. Mirrors InstructionPanel.ts:
// the session segmented control, the right-aligned header-action icon row
// (Settings · History · Pack · Clean · Magic Polish · Erase), the open Tool-
// configuration dropdown (Attach TeX Count [checked] / Attach Diagnostics),
// and the agent (sparkle) + model (robot) select pills in the footer. Icon
// names and labels match the configuration.md "Agent Execution Settings"
// prose. Reuses the .phead/.seg/.hactions/.iact/.select/.footer/.sgroup chrome
// from QuickStartHero and the open .wa-menu/.wa-item/.wa-check checkbox dropdown
// — all from mockup.css; no editor pane, no window chrome. The root carries
// `.mockup`, so it inherits the --mk-* tokens and flips with the docs theme.
const actions = [
  { icon: 'gear', label: 'Settings' },
  { icon: 'history', label: 'History' },
  { icon: 'archive', label: 'Pack' },
  { icon: 'trash', label: 'Clean' },
  { icon: 'sparkle', label: 'Magic Polish' },
  { icon: 'clear-all', label: 'Erase' },
];
</script>

<template>
  <div class="mockup ihc" role="group" aria-label="Instruction panel header">
    <div class="lpanel">
      <!-- Instruction label row + the Tool-configuration trigger -->
      <div class="phead">
        <span class="ihc-lbl">
          <wa-icon class="ihc-lbl-ic" library="texra" name="pencil"></wa-icon>
          Instruction
          <span class="act act-on" title="Tool configuration options">
            <wa-icon library="texra" name="tools"></wa-icon>
          </span>
        </span>
        <div class="hactions">
          <span
            v-for="a in actions"
            :key="a.label"
            class="iact"
            :title="a.label"
          >
            <wa-icon library="texra" :name="a.icon"></wa-icon>
          </span>
        </div>
      </div>

      <!-- Open Tool-configuration dropdown (two checkbox items). -->
      <div class="wa-menu">
        <div class="wa-item checked">
          <span class="wa-check">
            <wa-icon library="texra" name="check"></wa-icon>
          </span>
          <wa-icon
            class="wa-lead"
            library="texra"
            name="symbol-numeric"
          ></wa-icon>
          Attach TeX Count
        </div>
        <div class="wa-item">
          <span class="wa-check"></span>
          <wa-icon class="wa-lead" library="texra" name="tools"></wa-icon>
          Attach Diagnostics
        </div>
      </div>

      <!-- Agent + Model selectors -->
      <div class="footer">
        <div class="sgroup">
          <span class="iact settings" title="Agent settings">
            <wa-icon library="texra" name="sparkle"></wa-icon>
          </span>
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
          <span class="iact settings" title="Model settings">
            <wa-icon library="texra" name="robot"></wa-icon>
          </span>
          <div class="select">
            <span class="s-val">sonnet5</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The Launcher chrome (.lpanel/.phead/.seg/.hactions/.iact/.select/.footer/
   .sgroup/.settings) and the open dropdown (.wa-menu/.wa-item/.wa-check) are
   shared via mockup.css. Only the frameless shell + the instruction label and
   a leading dropdown icon are unique here. */
.ihc {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  max-width: var(--mk-size-470);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

.ihc-lbl {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-6);
  font-size: var(--mk-fs-80);
  font-weight: 600;
  color: var(--mk-text);
}
.ihc-lbl-ic {
  font-size: var(--mk-space-12);
  color: var(--color-text-secondary);
}

/* The Tool-config trigger beside the label (mirrors the .act act-on glyph in
   FileSelectGroup.ts headers). */
.ihc-lbl .act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-space-22);
  height: var(--mk-space-22);
  border-radius: var(--mk-radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--mk-space-12);
}
.ihc-lbl .act-on {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
}

/* The open checkbox dropdown (.wa-menu/.wa-item/.wa-check/.wa-lead) is shared
   via mockup.css. The menu hangs directly under the Tool-config trigger, and
   its rows carry a leading category icon, so they sit a touch tighter than the
   shared default — only that offset and gap are unique here. */
.wa-menu {
  margin: calc(-1 * var(--mk-space-6)) 0 0 0;
}
.wa-item {
  gap: var(--mk-space-7);
}
</style>
