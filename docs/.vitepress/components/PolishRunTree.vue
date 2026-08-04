<script setup>
// Frameless task-storage file tree for guide/first-run.md ("In the terminal").
// Polish writes one folder per round under executions/<run-id>/ in the
// workspace store, and KEEPS the
// input filename (draft.tex, not output.tex). r0 is the first revision, r1 the
// critique pass / final. A side note pins the preserved-filename point, and a
// dimmed sibling leaf shows the --output draft.polished.tex alternative.
//
// Standalone (no MockupFrame) — composed inside the shared <MockCard> primitive
// so the card shell + inline mono header come for free and flip with the docs
// light / dark themes. Static strings only.
import MockCard from './MockCard.vue';

const rounds = [
  {
    name: 'r0/',
    state: 'done',
    tag: 'first revision',
    note: 'reads draft.tex, applies your instruction',
  },
  {
    name: 'r1/',
    state: 'done',
    tag: 'critique pass · final',
    note: 'rereads r0, revises again',
  },
];
</script>

<template>
  <MockCard
    class="prt"
    title="executions/"
    icon="folder-opened"
    sub="one folder per round · input filename preserved"
  >
    <div class="prt-tree">
      <div class="prt-folder prt-run">
        <wa-icon
          class="prt-fld-ic"
          library="texra"
          name="folder-opened"
        ></wa-icon>
        <code class="prt-fld-name">&lt;run-id&gt;/</code>
      </div>

      <div v-for="r in rounds" :key="r.name" class="prt-round">
        <div class="prt-folder">
          <span class="prt-dot prt-dot--done"></span>
          <wa-icon
            class="prt-fld-ic"
            library="texra"
            name="folder-opened"
          ></wa-icon>
          <code class="prt-fld-name">{{ r.name }}</code>
          <span
            class="prt-tag"
            :class="{ 'prt-tag--final': r.name === 'r1/' }"
            >{{ r.tag }}</span
          >
        </div>
        <ul class="prt-files">
          <li class="prt-file">
            <wa-icon
              class="prt-f-ic"
              library="texra"
              name="file-code"
            ></wa-icon>
            <code class="prt-f-name">draft.tex</code>
            <span class="prt-f-note">{{ r.note }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div class="prt-foot">
      <wa-icon class="prt-foot-ic" library="texra" name="file-code"></wa-icon>
      <code class="prt-foot-name">draft.polished.tex</code>
      <span class="prt-foot-tag">--output</span>
      <span class="prt-foot-note">written next to your input instead</span>
    </div>
  </MockCard>
</template>

<style scoped>
/* Card shell + mono header come from <MockCard>; only the body is scoped here. */
.prt-tree {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
}
.prt-folder {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
}
.prt-run {
  margin-bottom: var(--mk-space-2);
}
.prt-round {
  margin-left: var(--mk-space-14);
}
.prt-dot {
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  flex-shrink: 0;
}
.prt-dot--done {
  background: var(--color-success);
}
.prt-fld-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.prt-fld-name {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}
.prt-tag {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-7);
}
.prt-tag--final {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--mk-accent) 32%, transparent);
}

.prt-files {
  list-style: none;
  margin: var(--mk-space-3) 0 0;
  padding: 0 0 0 var(--mk-space-14);
  border-left: 1px solid var(--mk-border);
  margin-left: var(--mk-space-4);
}
.prt-file {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  line-height: 1.5;
}
.prt-f-ic {
  align-self: center;
  font-size: var(--mk-space-11);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.prt-f-name {
  font-size: var(--mk-fs-76);
  color: var(--color-text-link);
}
.prt-f-note {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}

.prt-foot {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-12);
  padding-top: var(--mk-space-10);
  border-top: 1px dashed var(--mk-border);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
}
.prt-foot-ic {
  align-self: center;
  font-size: var(--mk-space-11);
  color: var(--mk-text-faint);
  flex-shrink: 0;
}
.prt-foot-name {
  font-size: var(--mk-fs-76);
  color: var(--mk-text-faint);
}
.prt-foot-tag {
  font-size: var(--mk-fs-68);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-accent) 32%, transparent);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-7);
}
.prt-foot-note {
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}
</style>
