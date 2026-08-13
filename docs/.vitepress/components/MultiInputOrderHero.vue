<script setup>
// Frameless figure for guide/multiple-output.md → "UI for Multiple Files".
// The prose claims each Input row is an *ordered* list and that, for editing
// agents, "the expected output filenames are the selected input filenames in
// the same order" — but never shows the multi-row ordered list itself.
//
// This lifts the Launcher's Input file group (the .field/.frow/.f-label +
// .flist/.fitem vocabulary shared with FileSelectHero) to show three stacked,
// ordered rows with their position index, the three header actions (Add opened
// files, Clear all, Add files), and a footer note that order → output order.
//
// Root carries `.mockup` so the shared `--mk-*` tokens + global .field/.flist/
// .fitem classes (theme/mockup.css) resolve here and the card flips between the
// docs light / dark themes.

// The ordered input files. `lift` marks one row as mid-drag to hint reorder.
const rows = [
  { n: 1, name: 'chapter1.tex' },
  { n: 2, name: 'chapter2.tex', lift: true },
  { n: 3, name: 'appendixA.tex' },
];
</script>

<template>
  <div
    class="mockup mk-card mi-hero"
    role="group"
    aria-label="ordered input files"
  >
    <div class="field">
      <div class="frow">
        <span class="f-label">
          <wa-icon class="lbl-ic" library="texra" name="file-code"></wa-icon>
          Input
        </span>
        <div class="acts">
          <span class="act" title="Add opened files as input">
            <wa-icon library="texra" name="folder-opened"></wa-icon>
          </span>
          <span class="act" title="Clear all input files">
            <wa-icon library="texra" name="trash"></wa-icon>
          </span>
          <span class="act" title="Add input files">
            <wa-icon library="texra" name="add"></wa-icon>
          </span>
        </div>
      </div>

      <div class="flist mi-flist">
        <div
          v-for="r in rows"
          :key="r.n"
          class="fitem mi-row"
          :class="{ 'mi-row--lift': r.lift }"
        >
          <wa-icon class="fi-grip" library="texra" name="ellipsis"></wa-icon>
          <span class="mi-ord">{{ r.n }}</span>
          <wa-icon
            class="t-tex mi-fi-ic"
            library="texra"
            name="file-code"
          ></wa-icon>
          <span class="fi-name">{{ r.name }}</span>
          <wa-icon class="fi-rm" library="texra" name="trash"></wa-icon>
        </div>
      </div>
    </div>

    <div class="mi-note">
      <wa-icon library="texra" name="arrow-down"></wa-icon>
      <span
        >Row order is the output order — editing agents reuse each input
        filename as its output filename.</span
      >
    </div>
  </div>
</template>

<style scoped>
/* Card shell + the .field/.flist/.fitem file-row vocabulary come from the
   shared `.mockup` globals (theme/mockup.css). Only the ordered-index badge,
   the drag-lift cue, and the footer note stay scoped. */
.mi-hero {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  padding: var(--mk-space-14);
  max-width: var(--mk-size-420, 26rem);
  font-family: var(--vp-font-family-base);
}

.mi-flist {
  gap: var(--mk-space-6);
}
.mi-row {
  position: relative;
}

/* Ordered position chip (1 / 2 / 3) — order == output order. */
.mi-ord {
  flex-shrink: 0;
  width: var(--mk-space-16);
  height: var(--mk-space-16);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-62);
  font-weight: 600;
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  border-radius: var(--mk-radius-pill);
}
.mi-fi-ic {
  font-size: var(--mk-fs-82);
  flex-shrink: 0;
}

/* Mid-drag cue on one row (decorative — reorderability hint). */
.mi-row--lift {
  border: 1px solid var(--mk-accent);
  box-shadow: 0 var(--mk-space-3) var(--mk-space-10) rgba(0, 0, 0, 0.25);
  transform: translateX(var(--mk-space-4));
}

.mi-note {
  display: flex;
  align-items: flex-start;
  gap: var(--mk-space-6);
  font-size: var(--mk-fs-72);
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.mi-note wa-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--mk-accent);
  font-size: var(--mk-fs-78);
}
</style>
