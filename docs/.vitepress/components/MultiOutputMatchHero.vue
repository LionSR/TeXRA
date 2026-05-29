<script setup>
// Frameless figure for guide/multiple-output.md → "How It Works: Agent Output
// & Extraction". Visualizes the name-matching step that the prose enumerates
// but never shows: the agent emits ONE XML response with `<document name="…">`
// blocks, and TeXRA matches each block's `name` against the expected output
// filenames to decide which files to save.
//
// Left column: the agent's `<documents>` response — two blocks whose names
// match (chapter2.tex, appendixA.tex) plus one stray (notes.tex) with no match.
// Right column: the "Expected outputs" file rows (the selected input filenames).
// Matched blocks carry a green "matched → saved" pill; the stray carries a
// muted "no match → skipped" pill.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// (defined on `.mockup` in theme/mockup.css) resolve here and the card flips
// cleanly between the docs light / dark themes.

// Agent response blocks. `match` true → highlighted + saved; the stray block
// (match false) is dimmed and skipped.
const blocks = [
  { name: 'chapter2.tex', match: true },
  { name: 'appendixA.tex', match: true },
  { name: 'notes.tex', match: false },
];

// Expected output filenames (the selected input filenames for an editing run).
const expected = ['chapter2.tex', 'appendixA.tex'];
</script>

<template>
  <div
    class="mockup mk-card mo-hero"
    role="group"
    aria-label="document name matching"
  >
    <!-- Left: the agent's single XML response -->
    <div class="mo-col">
      <div class="mk-card-head">
        <wa-icon class="mk-card-head-ic" library="texra" name="robot"></wa-icon>
        <span class="mk-card-title">agent response</span>
        <span class="mk-card-sub">one XML message</span>
      </div>
      <div class="surface mo-surface">
        <div class="cl"><span class="kw">&lt;documents&gt;</span></div>
        <template v-for="(b, i) in blocks" :key="i">
          <div class="cl indent mo-open" :class="{ dim: !b.match }">
            <span class="kw">&lt;document</span>
            <span class="attr">name</span>=<span class="str"
              >"{{ b.name }}"</span
            ><span class="kw">&gt;</span>
          </div>
          <div class="cl indent2 cmt" :class="{ dim: !b.match }">
            % … content for {{ b.name }} …
          </div>
          <div class="cl indent mo-open" :class="{ dim: !b.match }">
            <span class="kw">&lt;/document&gt;</span>
          </div>
        </template>
        <div class="cl"><span class="kw">&lt;/documents&gt;</span></div>
      </div>
    </div>

    <!-- Connector: matched names flow into expected outputs -->
    <div class="mo-arrow" aria-hidden="true">
      <wa-icon library="texra" name="arrow-right"></wa-icon>
      <span class="mo-arrow-lbl">match&nbsp;by&nbsp;name</span>
    </div>

    <!-- Right: the expected output filenames + match verdict -->
    <div class="mo-col">
      <div class="mk-card-head">
        <wa-icon
          class="mk-card-head-ic"
          library="texra"
          name="file-code"
        ></wa-icon>
        <span class="mk-card-title">expected outputs</span>
        <span class="mk-card-sub">selected input filenames</span>
      </div>
      <div class="flist mo-flist">
        <div v-for="(name, i) in expected" :key="i" class="fitem">
          <wa-icon
            class="t-tex mo-fi-ic"
            library="texra"
            name="file-code"
          ></wa-icon>
          <span class="fi-name">{{ name }}</span>
          <span class="ph-tag ph-tag--ok">matched → saved</span>
        </div>
        <div class="fitem mo-skip">
          <wa-icon
            class="mo-fi-ic mo-fi-ic--off"
            library="texra"
            name="file"
          ></wa-icon>
          <span class="fi-name mo-fi-name--off">notes.tex</span>
          <span class="ph-tag">no match → skipped</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Card shell + inline-mono header come from the shared `.mk-card*` family
   (theme/mockup.css). Only the grid layout + the symmetric padding override
   (the shell is a 3-column grid, not the default card body) stay scoped. */
.mo-hero {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--mk-space-12);
  padding: var(--mk-space-14);
}

.mo-col {
  min-width: 0;
}

/* Code surface (reuses .surface/.cl/.kw/.cmt/.indent tokens). */
.mo-surface {
  padding: var(--mk-space-10) var(--mk-space-12);
  font-size: var(--mk-fs-76);
  line-height: 1.6;
  background: var(--mk-bg-deep);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-md);
}
.mo-surface .attr {
  color: var(--mk-syn-var);
}
.mo-surface .str {
  color: var(--mk-syn-fn);
}
.mo-surface .dim {
  opacity: 0.42;
}

/* Connector */
.mo-arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--mk-space-4);
  color: var(--mk-accent);
}
.mo-arrow wa-icon {
  font-size: var(--mk-space-16);
}
.mo-arrow-lbl {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--mk-text-faint);
}

/* Expected-output file rows (reuses .flist/.fitem/.fi-name/.t-tex). */
.mo-flist {
  gap: var(--mk-space-6);
  padding: var(--mk-space-8);
}
.mo-fi-ic {
  font-size: var(--mk-fs-82);
  flex-shrink: 0;
}
.mo-fi-ic--off {
  color: var(--mk-text-faint);
}
.mo-fi-name--off {
  color: var(--mk-text-faint);
  text-decoration: line-through;
}
.mo-skip {
  background: transparent;
  border: 1px dashed var(--color-border);
}

/* Match / skip verdict pills (reuses CompareHero's .ph-tag vocabulary). */
.ph-tag {
  margin-left: auto;
  flex-shrink: 0;
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-8);
}
.ph-tag--ok {
  color: var(--color-success);
  background: rgba(105, 176, 106, 0.16);
}

/* Stack to a single column on narrow screens; flip the arrow to point down. */
@media (max-width: 620px) {
  .mo-hero {
    grid-template-columns: 1fr;
  }
  .mo-arrow {
    flex-direction: row;
    justify-content: center;
  }
  .mo-arrow wa-icon {
    transform: rotate(90deg);
  }
}
</style>
