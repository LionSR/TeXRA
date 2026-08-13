<script setup>
// Frameless figure for guide/multiple-output.md → "Tracking Multi-Output Runs".
// The page contrasts two ways output filenames are determined, spread over
// three paragraphs + a YAML snippet:
//   • Editing agents reuse the selected INPUT_FILES as the output names.
//   • Generator agents declare settings.defaultOutputFiles, exposed as
//     OUTPUT_FILES, when the outputs are not the inputs.
//
// This shows both modes side by side: each card maps input file rows → output
// file rows, driven by the variable chip in its header (INPUT_FILES vs
// defaultOutputFiles → OUTPUT_FILES). Reuses the .fitem/.fi-name file-row
// vocabulary and the .mk-card shell from the shared `.mockup` globals.

const editing = {
  driver: 'INPUT_FILES',
  inputs: ['chapter2.tex', 'appendixA.tex'],
  // Editing agents reuse the same names — outputs mirror inputs.
  outputs: ['chapter2.tex', 'appendixA.tex'],
};

const generator = {
  driver: 'defaultOutputFiles → OUTPUT_FILES',
  inputs: ['notes.md'],
  // Generator agents declare fixed new filenames.
  outputs: ['paper_section.tex', 'appendix.tex'],
};
</script>

<template>
  <div
    class="mockup mo2-hero"
    role="group"
    aria-label="how output filenames are determined"
  >
    <!-- Editing agent: inputs become outputs -->
    <div class="mk-card mo2-card">
      <div class="mk-card-head">
        <wa-icon
          class="mk-card-head-ic"
          library="texra"
          name="pencil"
        ></wa-icon>
        <span class="mk-card-title">editing agent</span>
        <span class="mk-card-sub">inputs become outputs</span>
      </div>
      <div class="mo2-body">
        <span class="mo2-chip">{{ editing.driver }}</span>
        <div class="mo2-flow">
          <div class="mo2-side">
            <span class="mo2-side-lbl">input files</span>
            <div class="fitem mo2-fi" v-for="f in editing.inputs" :key="f">
              <wa-icon
                class="t-tex mo2-fi-ic"
                library="texra"
                name="file-code"
              ></wa-icon>
              <span class="fi-name">{{ f }}</span>
            </div>
          </div>
          <wa-icon
            class="mo2-arrow"
            library="texra"
            name="arrow-right"
          ></wa-icon>
          <div class="mo2-side">
            <span class="mo2-side-lbl">output files</span>
            <div
              class="fitem mo2-fi mo2-fi--out"
              v-for="f in editing.outputs"
              :key="f"
            >
              <wa-icon
                class="t-tex mo2-fi-ic"
                library="texra"
                name="file-code"
              ></wa-icon>
              <span class="fi-name">{{ f }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Generator agent: fixed declared outputs -->
    <div class="mk-card mo2-card">
      <div class="mk-card-head">
        <wa-icon
          class="mk-card-head-ic"
          library="texra"
          name="sparkle"
        ></wa-icon>
        <span class="mk-card-title">generator agent</span>
        <span class="mk-card-sub">declares fixed outputs</span>
      </div>
      <div class="mo2-body">
        <span class="mo2-chip">{{ generator.driver }}</span>
        <div class="mo2-flow">
          <div class="mo2-side">
            <span class="mo2-side-lbl">input files</span>
            <div class="fitem mo2-fi" v-for="f in generator.inputs" :key="f">
              <wa-icon
                class="mo2-fi-ic mo2-fi-ic--src"
                library="texra"
                name="file"
              ></wa-icon>
              <span class="fi-name">{{ f }}</span>
            </div>
          </div>
          <wa-icon
            class="mo2-arrow"
            library="texra"
            name="arrow-right"
          ></wa-icon>
          <div class="mo2-side">
            <span class="mo2-side-lbl">output files</span>
            <div
              class="fitem mo2-fi mo2-fi--out"
              v-for="f in generator.outputs"
              :key="f"
            >
              <wa-icon
                class="t-tex mo2-fi-ic"
                library="texra"
                name="file-code"
              ></wa-icon>
              <span class="fi-name">{{ f }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Two .mk-card panels side by side. The .mk-card shell + .fitem/.fi-name file
   rows come from the shared `.mockup` globals (theme/mockup.css); only the
   two-column grid, the driver chip, and the input→output flow stay scoped. */
.mo2-hero {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
  font-family: var(--vp-font-family-base);
}
.mo2-card {
  min-width: 0;
}
.mo2-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  padding: var(--mk-space-12);
}

/* The variable that drives the names (INPUT_FILES / OUTPUT_FILES). */
.mo2-chip {
  align-self: flex-start;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-66);
  font-weight: 600;
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-accent) 28%, transparent);
  border-radius: var(--mk-radius-pill);
  padding: var(--mk-space-2) var(--mk-space-9);
}

.mo2-flow {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.mo2-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-5);
}
.mo2-side-lbl {
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--mk-text-faint);
}
.mo2-fi {
  gap: var(--mk-space-6);
  padding: var(--mk-space-3) var(--mk-space-6);
}
.mo2-fi-ic {
  font-size: var(--mk-fs-78);
  flex-shrink: 0;
}
.mo2-fi-ic--src {
  color: var(--color-text-tertiary);
}
.mo2-fi .fi-name {
  font-size: var(--mk-fs-72);
}
.mo2-fi--out .fi-name {
  color: var(--color-success);
}
.mo2-arrow {
  flex-shrink: 0;
  color: var(--mk-accent);
  font-size: var(--mk-space-16);
}

@media (max-width: 720px) {
  .mo2-hero {
    grid-template-columns: 1fr;
  }
}
</style>
