<script setup>
// Frameless run-storage file tree for guide/agent-architecture.md. Each
// revision saves r{n}/output.xml (the raw LLM response, dim) then the
// extracted r{n}/<input-stem>.tex (link-coloured, e.g. paper.tex). The
// latexdiff source is diff/r{n}/<input-stem>_diff.tex and its compiled PDF
// output/r{n}/<input-stem>-diff.pdf. r0 is the draft, r1 the review pass. A
// caption beside r0's paper.tex names the extraction step.
//
// Standalone (no MockupFrame) — the focused tree composed inside the shared
// <MockCard> primitive, so the card shell + inline mono header come for free
// and it flips with the docs light / dark themes.
import MockCard from './MockCard.vue';

const rounds = [
  {
    name: 'r0/',
    state: 'done',
    tag: 'Revision 1: draft',
    files: [
      { name: 'output.xml', kind: 'xml', note: 'raw LLM response' },
      { name: 'paper.tex', kind: 'tex', note: 'extracted, named after input' },
    ],
  },
  {
    name: 'r1/',
    state: 'done',
    tag: 'Revision 2: review',
    files: [
      { name: 'output.xml', kind: 'xml' },
      { name: 'paper.tex', kind: 'tex' },
    ],
  },
  {
    name: 'diff/',
    state: 'done',
    tag: 'latexdiff vs input',
    files: [
      { name: 'r0/paper_diff.tex', kind: 'tex' },
      { name: 'r1/paper_diff.tex', kind: 'tex' },
    ],
  },
  {
    name: 'output/',
    state: 'done',
    tag: 'compiled diffs',
    files: [
      { name: 'r0/paper-diff.pdf', kind: 'pdf' },
      { name: 'r1/paper-diff.pdf', kind: 'pdf' },
    ],
  },
];

const icon = (kind) =>
  kind === 'tex' ? 'file-code' : kind === 'pdf' ? 'file-pdf' : 'file-lines';
</script>

<template>
  <MockCard
    class="rot"
    title="run storage"
    icon="folder-opened"
    sub="one folder per revision"
  >
    <div class="rot-tree">
      <div v-for="r in rounds" :key="r.name" class="rot-round">
        <div class="rot-folder">
          <span class="rot-dot" :class="`rot-dot--${r.state}`"></span>
          <wa-icon
            class="rot-fld-ic"
            library="texra"
            name="folder-opened"
          ></wa-icon>
          <code class="rot-fld-name">{{ r.name }}</code>
          <span class="rot-tag" :class="{ 'rot-tag--r0': r.name === 'r0/' }">{{
            r.tag
          }}</span>
        </div>

        <ul class="rot-files">
          <li
            v-for="(f, i) in r.files"
            :key="f.name"
            class="rot-file"
            :class="`f-${f.kind}`"
          >
            <wa-icon
              class="rot-f-ic"
              :class="`fi-${f.kind}`"
              library="texra"
              :name="icon(f.kind)"
            ></wa-icon>
            <code class="rot-f-name" :class="`fn-${f.kind}`">{{ f.name }}</code>
            <span v-if="f.note" class="rot-f-note">{{ f.note }}</span>
            <span
              v-if="f.kind === 'tex' && r.name === 'r0/'"
              class="rot-extract"
            >
              <wa-icon
                library="texra"
                name="arrow-up"
                class="rot-ex-ic"
              ></wa-icon>
              extract <code>&lt;document&gt;…&lt;/document&gt;</code>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
/* The card shell + inline mono header come from <MockCard> (which composes the
   shared .mk-card / .mk-card-head family from theme/mockup.css). Only the body
   tree below is scoped here. */
.rot-tree {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-12);
}

.rot-folder {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
}
.rot-dot {
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  flex-shrink: 0;
}
.rot-dot--done {
  background: var(--color-success);
}
.rot-dot--active {
  background: var(--mk-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--mk-accent) 60%, transparent);
  animation: mk-shpulse 1.8s infinite;
}
.rot-fld-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.rot-fld-name {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}
.rot-tag {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-7);
}
.rot-tag--r0 {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--mk-accent) 32%, transparent);
}

.rot-files {
  list-style: none;
  margin: var(--mk-space-4) 0 0;
  padding: 0 0 0 var(--mk-space-14);
  border-left: 1px solid var(--mk-border);
  margin-left: var(--mk-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
}
.rot-file {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  line-height: 1.5;
}
.rot-f-ic {
  align-self: center;
  font-size: var(--mk-space-11);
  flex-shrink: 0;
}
.rot-f-ic.fi-tex {
  color: var(--mk-syn-fn);
}
.rot-f-ic.fi-pdf {
  color: var(--color-error);
}
.rot-f-ic.fi-xml {
  color: var(--mk-text-faint);
}
.rot-f-name {
  font-size: var(--mk-fs-76);
}
.fn-tex {
  color: var(--color-text-link);
}
.fn-pdf {
  color: var(--mk-text);
}
.fn-xml {
  color: var(--mk-text-faint);
}
.rot-f-note {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}
.rot-extract {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: var(--mk-space-5);
  margin-left: var(--mk-space-16);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  color: var(--mk-accent);
}
.rot-extract code {
  font-family: var(--vp-font-family-mono);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-4);
}
.rot-ex-ic {
  font-size: var(--mk-space-10);
}
</style>
