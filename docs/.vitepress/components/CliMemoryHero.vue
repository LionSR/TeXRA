<script setup>
// Terminal card for `texra memory list` / `memory show` — guide/memory.md's
// "Managing memories from the Dashboard" section, terminal counterpart. The
// real list output (packages/cli/src/runtime/memory.ts formatCliMemoryList)
// is a `Memories (N):` header then one `<displayPath>\t<description>` row per
// note, where the description joins `pinned; <size>; modified: <date>; by
// <agent>`; `memory show memories/<file>` previews one note. File names match
// the page's Dashboard mockups (project-conventions.md) so both surfaces tell
// one story.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
const rows = [
  {
    path: '/memories/project-conventions.md',
    desc: 'pinned; 1.2K; modified: 11/4/2025, 2:31:08 PM; by research',
    pinned: true,
  },
  {
    path: '/memories/notation.md',
    desc: '819B; modified: 10/28/2025, 10:04:51 AM; by assistant',
    pinned: false,
  },
  {
    path: '/memories/related-work.md',
    desc: '2.4K; modified: 10/21/2025, 4:48:27 PM; by research',
    pinned: false,
  },
];
</script>

<template>
  <TermWindow
    title="texra memory"
    aria-label="texra memory list and show output"
  >
    <!-- Beat 1: list the store -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra memory list</span>
    </div>
    <div class="cmh-head">Memories (3):</div>
    <ul class="cmh-rows">
      <li v-for="r in rows" :key="r.path" class="cmh-row">
        <span class="cmh-path" :class="{ 'cmh-path--pinned': r.pinned }">{{
          r.path
        }}</span>
        <span class="cmh-desc">{{ r.desc }}</span>
      </li>
    </ul>

    <!-- Beat 2: preview one note -->
    <div class="mk-term-prompt cmh-show">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra memory show memories/project-conventions.md</span
      >
    </div>
    <div class="cmh-meta">
      <div>Memory: /memories/project-conventions.md</div>
      <div>9 lines</div>
    </div>
    <div class="cmh-preview">
      <div># Project conventions</div>
      <div>- Use \lambda_2 (not \mu) for the second eigenvalue.</div>
      <div>- Cite the journal version of Chung (1997), not the preprint.</div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.cmh-head {
  margin-top: var(--mk-space-7);
  color: var(--mk-text-dim);
  font-weight: 600;
  font-size: var(--mk-fs-74);
}
.cmh-rows {
  list-style: none;
  margin: var(--mk-space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
}
.cmh-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-10);
  font-size: var(--mk-fs-72);
}
.cmh-path {
  color: var(--color-text-link);
  flex-shrink: 0;
}
.cmh-path--pinned {
  color: var(--mk-accent);
  font-weight: 600;
}
.cmh-desc {
  color: var(--mk-text-faint);
  min-width: 0;
}

.cmh-show {
  margin-top: var(--mk-space-10);
  flex-wrap: wrap;
}
.cmh-meta {
  margin-top: var(--mk-space-4);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-dim);
  font-size: var(--mk-fs-72);
}
.cmh-preview {
  margin-top: var(--mk-space-5);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
  line-height: 1.7;
}
</style>
