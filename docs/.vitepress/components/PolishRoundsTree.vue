<script setup>
// Frameless task-storage tree for the polish run. The page's "Run it from the
// CLI" section enumerates the round layout as a code-fenced path list, where
// BOTH rounds reuse the input filename (intro.tex) under r0/ and r1/ — the
// single most confusing structural fact on the page. This card draws that
// folder shape with a one-line annotation per round so the r0 (first revision)
// vs r1 (critique pass · final) distinction reads at a glance.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// (defined in theme/mockup.css on `.mockup`) resolve here and the card flips
// cleanly between the docs light / dark themes. Static strings only.
const rounds = [
  {
    dir: 'r0/',
    file: 'intro.tex',
    tag: 'first revision',
    recommended: false,
  },
  {
    dir: 'r1/',
    file: 'intro.tex',
    tag: 'critique pass · final',
    recommended: true,
  },
];
</script>

<template>
  <div
    class="mockup mk-card prt"
    role="group"
    aria-label="polish run task storage layout"
  >
    <div class="mk-card-head prt-head">
      <wa-icon class="mk-card-head-ic" library="texra" name="folder"></wa-icon>
      <span class="mk-card-title prt-head-name"
        >executions/&lt;run-id&gt;/</span
      >
      <span class="mk-card-sub prt-head-sub">one folder per round</span>
    </div>
    <ul class="prt-tree">
      <li
        v-for="(r, i) in rounds"
        :key="i"
        class="prt-round"
        :class="{ 'prt-round--final': r.recommended }"
      >
        <span class="prt-dir">
          <wa-icon class="prt-dir-ic" library="texra" name="folder"></wa-icon>
          <span class="prt-dir-name">{{ r.dir }}</span>
        </span>
        <span class="prt-leaf">
          <wa-icon
            class="prt-leaf-ic"
            library="texra"
            name="file-code"
          ></wa-icon>
          <span class="prt-leaf-name">{{ r.file }}</span>
          <span class="prt-tag" :class="{ 'prt-tag--final': r.recommended }">{{
            r.tag
          }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Card shell + inline mono header reuse the shared .mk-card* family
   (theme/mockup.css on `.mockup`). Header runs base-font with no bottom margin,
   matching the sibling CritiquePassCard so the two read as one family. */
.prt-head {
  margin-bottom: 0;
}
.prt-head-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
}
.prt-head-sub {
  font-family: var(--vp-font-family-base);
}

.prt-tree {
  list-style: none;
  margin: var(--mk-space-10) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.prt-round {
  padding: var(--mk-space-8) var(--mk-space-10);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
}
.prt-round--final {
  border-left: 2px solid var(--mk-accent);
}

.prt-dir {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
}
.prt-dir-ic {
  color: var(--color-text-secondary);
  font-size: var(--mk-fs-78);
}
.prt-dir-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}

.prt-leaf {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  /* indent the file under its round folder, with a faint tree elbow */
  margin: var(--mk-space-4) 0 0 var(--mk-space-10);
  padding-left: var(--mk-space-10);
  border-left: 1px solid var(--mk-border-soft);
}
.prt-leaf-ic {
  color: var(--mk-syn-fn);
  font-size: var(--mk-fs-78);
}
.prt-leaf-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  color: var(--mk-text);
}
.prt-tag {
  margin-left: var(--mk-space-4);
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
}
.prt-tag--final {
  color: var(--mk-accent);
  font-weight: 600;
}
</style>
