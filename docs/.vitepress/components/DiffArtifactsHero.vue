<script setup>
// Frameless artifact-tree card for guide/latex-diff.md "Manage Diff Outputs":
// the diff file-naming scheme is scattered across the page in prose — latexdiff
// emits `_diff.tex`, latexdiff-vc emits `-diff<hash>.tex`, and between-round
// runs emit `_diffr<newer>r<older>.tex`. This grounds the set: the source pair on top,
// then each generated diff with its .tex source + compiled .pdf, tagged by the
// tool that made it. The header carries the same Pack / Clean toolbar the
// LaTeXDiffs section exposes (mirrors LatexDiffHero's .act buttons) so it's
// clear what those buttons act on.
//
// Standalone (no MockupFrame): just the focused artifact card. The root carries
// `.mockup` so the shared `--mk-*` tokens resolve and it flips cleanly between
// the docs light / dark themes. Static example names reuse LatexDiffHero's
// `spectral-gap` document so the two figures read as one system.
const groups = [
  {
    label: 'Source',
    rows: [
      {
        name: 'spectral-gap.tex',
        icon: 'file-code',
        kind: 'tex',
        note: 'base',
      },
      {
        name: 'spectral-gap_polish_r1.tex',
        icon: 'file-code',
        kind: 'tex',
        note: 'edited',
      },
    ],
  },
  {
    label: 'Generated diffs',
    rows: [
      {
        name: 'spectral-gap_diff.tex',
        icon: 'file-code',
        kind: 'tex',
        tag: 'latexdiff',
      },
      { name: 'spectral-gap_diff.pdf', icon: 'file-pdf', kind: 'pdf' },
      {
        name: 'spectral-gap-diffa3f9c1.tex',
        icon: 'file-code',
        kind: 'tex',
        tag: 'latexdiff-vc',
        commit: 'a3f9c1',
      },
      {
        name: 'spectral-gap-diffa3f9c1.pdf',
        icon: 'file-pdf',
        kind: 'pdf',
      },
      {
        name: 'spectral-gap_diffr1r0.tex',
        icon: 'file-code',
        kind: 'tex',
        tag: 'between-round',
      },
      { name: 'spectral-gap_diffr1r0.pdf', icon: 'file-pdf', kind: 'pdf' },
    ],
  },
];
</script>

<template>
  <div
    class="mockup mk-card da-card"
    role="group"
    aria-label="Generated diff artifacts"
  >
    <div class="mk-card-head da-head">
      <wa-icon
        class="mk-card-head-ic"
        library="texra"
        name="diff-single"
      ></wa-icon>
      <span class="mk-card-title">Diff artifacts</span>
      <span class="mk-card-sub">naming · lifecycle</span>
      <div class="da-acts">
        <span class="act" title="Pack latexdiff output"
          ><wa-icon library="texra" name="archive"></wa-icon> Pack</span
        >
        <span class="act" title="Clean latexdiff output"
          ><wa-icon library="texra" name="trash"></wa-icon> Clean</span
        >
      </div>
    </div>

    <div v-for="(g, gi) in groups" :key="gi" class="da-group">
      <div class="da-glabel">{{ g.label }}</div>
      <ul class="da-list">
        <li
          v-for="(r, ri) in g.rows"
          :key="ri"
          class="da-row"
          :class="{ 'da-row--pdf': r.kind === 'pdf' }"
        >
          <wa-icon
            class="da-ic"
            :class="`da-ic--${r.kind}`"
            library="texra"
            :name="r.icon"
          ></wa-icon>
          <code class="da-name">{{ r.name }}</code>
          <span v-if="r.note" class="da-note">{{ r.note }}</span>
          <span v-if="r.commit" class="da-commit"
            ><wa-icon library="texra" name="git-commit"></wa-icon
            >{{ r.commit }}</span
          >
          <span v-if="r.tag" class="da-tag" :class="`da-tag--${r.tag}`">{{
            r.tag
          }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* Card shell + mono header come from the shared .mk-card* family
   (theme/mockup.css). Only the deltas live here. */
.da-head {
  flex-wrap: wrap;
}
.da-acts {
  margin-left: auto;
  display: flex;
  gap: var(--mk-space-6);
}
/* Inherits .act hover from mockup.css; widen for the inline label. */
.da-acts .act {
  width: auto;
  gap: var(--mk-space-5);
  padding: var(--mk-space-3) var(--mk-space-7);
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
}

.da-group + .da-group {
  margin-top: var(--mk-space-10);
}
.da-glabel {
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--mk-text-faint);
  margin-bottom: var(--mk-space-5);
}
.da-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.da-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-5) var(--mk-space-2);
  min-width: 0;
}
/* The compiled .pdf hangs under its .tex source. */
.da-row--pdf {
  padding-left: var(--mk-space-14);
}
.da-row--pdf .da-name {
  color: var(--mk-text-faint);
}

.da-ic {
  flex-shrink: 0;
  font-size: var(--mk-space-13);
}
.da-ic--tex {
  color: var(--mk-syn-fn);
}
.da-ic--pdf {
  color: var(--mk-del-text);
}

.da-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  color: var(--mk-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.da-note {
  flex-shrink: 0;
  font-size: var(--mk-fs-62);
  color: var(--mk-text-faint);
  font-style: italic;
}

.da-commit {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-3);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-62);
  color: var(--color-text-secondary);
}

.da-tag {
  flex-shrink: 0;
  margin-left: auto;
  font-size: var(--mk-fs-62);
  font-weight: 600;
  padding: var(--mk-space-2) var(--mk-space-6);
  border-radius: var(--mk-radius-sm);
  border: 1px solid var(--mk-border);
  white-space: nowrap;
}
.da-tag--latexdiff {
  color: var(--mk-accent);
  border-color: color-mix(in srgb, var(--mk-accent) 45%, transparent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
}
.da-tag--latexdiff-vc {
  color: var(--mk-syn-fn);
  border-color: color-mix(in srgb, var(--mk-syn-fn) 45%, transparent);
  background: color-mix(in srgb, var(--mk-syn-fn) 12%, transparent);
}
.da-tag--between-round {
  color: var(--mk-text-faint);
}

@media (max-width: 560px) {
  .da-tag {
    display: none;
  }
  .da-name {
    white-space: normal;
    word-break: break-word;
  }
}
</style>
