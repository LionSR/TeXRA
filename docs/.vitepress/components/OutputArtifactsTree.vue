<script setup>
// Frameless task-storage file tree for guide/quick-start.md
// ("Understanding the Output"). A completed run writes one folder per round
// under task storage; each round holds the three artifact types the section
// enumerates — the Output file, the Log, and the Diff PDF — and crucially the
// document keeps its INPUT filename (draft.tex, not output.tex). r0/ is shown
// expanded with its trio; a collapsed sibling r1/ implies the per-round scheme.
//
// Standalone (no MockupFrame): composed inside the shared <MockCard> primitive
// so the card shell + inline mono header come for free and it flips with the
// docs light / dark themes. Names match the page exactly (draft.tex from the
// Create Sample Project example).
import MockCard from './MockCard.vue';

const files = [
  {
    name: 'draft.tex',
    kind: 'tex',
    role: 'Output',
    note: 'input filename preserved',
  },
  { name: 'draft.log', kind: 'log', role: 'Log', note: 'process details' },
  {
    name: 'draft_polish_r0_diff.pdf',
    kind: 'pdf',
    role: 'Diff',
    note: 'original vs revised',
  },
];

const icon = (kind) =>
  kind === 'tex' ? 'file-code' : kind === 'pdf' ? 'file-pdf' : 'file-lines';
</script>

<template>
  <MockCard
    class="oat"
    title="task storage"
    icon="folder-opened"
    sub="r{round}/<input-filename>"
  >
    <div class="oat-tree">
      <div class="oat-round">
        <div class="oat-folder">
          <span class="oat-dot oat-dot--done"></span>
          <wa-icon
            class="oat-fld-ic"
            library="texra"
            name="folder-opened"
          ></wa-icon>
          <code class="oat-fld-name">r0/</code>
          <span class="oat-tag oat-tag--r0">Round 0</span>
        </div>

        <ul class="oat-files">
          <li
            v-for="f in files"
            :key="f.name"
            class="oat-file"
            :class="`f-${f.kind}`"
          >
            <wa-icon
              class="oat-f-ic"
              :class="`fi-${f.kind}`"
              library="texra"
              :name="icon(f.kind)"
            ></wa-icon>
            <code class="oat-f-name" :class="`fn-${f.kind}`">{{ f.name }}</code>
            <span class="oat-role">{{ f.role }}</span>
            <span class="oat-f-note">{{ f.note }}</span>
          </li>
        </ul>
      </div>

      <div class="oat-round">
        <div class="oat-folder oat-folder--collapsed">
          <span class="oat-dot oat-dot--idle"></span>
          <wa-icon
            class="oat-fld-ic oat-fld-ic--idle"
            library="texra"
            name="folder"
          ></wa-icon>
          <code class="oat-fld-name oat-fld-name--idle">r1/</code>
          <span class="oat-tag">next round, same trio</span>
        </div>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
/* The card shell + inline mono header come from <MockCard> (which composes the
   shared .mk-card / .mk-card-head family from theme/mockup.css). Only the body
   tree below is scoped here; it mirrors RoundOutputTree's vocabulary. */
.oat-tree {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
}

.oat-folder {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
}
.oat-dot {
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  flex-shrink: 0;
}
.oat-dot--done {
  background: var(--color-success);
}
.oat-dot--idle {
  background: var(--mk-border);
}
.oat-fld-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.oat-fld-ic--idle {
  color: var(--mk-text-faint);
}
.oat-fld-name {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}
.oat-fld-name--idle {
  color: var(--mk-text-faint);
  font-weight: 500;
}
.oat-tag {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-7);
}
.oat-tag--r0 {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--mk-accent) 32%, transparent);
}

.oat-files {
  list-style: none;
  margin: var(--mk-space-4) 0 0;
  padding: 0 0 0 var(--mk-space-14);
  border-left: 1px solid var(--mk-border);
  margin-left: var(--mk-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.oat-file {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  line-height: 1.5;
}
.oat-f-ic {
  align-self: center;
  font-size: var(--mk-space-11);
  flex-shrink: 0;
}
.oat-f-ic.fi-tex {
  color: var(--mk-syn-fn);
}
.oat-f-ic.fi-pdf {
  color: #e0524f;
}
.oat-f-ic.fi-log {
  color: var(--mk-text-faint);
}
.oat-f-name {
  font-size: var(--mk-fs-76);
}
.fn-tex {
  color: var(--color-text-link);
}
.fn-pdf,
.fn-log {
  color: var(--mk-text);
}
/* The artifact-type label (Output / Log / Diff) as a small accent chip. */
.oat-role {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-68);
  font-weight: 600;
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-accent) 32%, transparent);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-6);
}
.oat-f-note {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}
</style>
