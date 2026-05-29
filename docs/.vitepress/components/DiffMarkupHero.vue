<script setup>
// Frameless markup-mapping card for guide/latex-diff.md: shows how latexdiff's
// source commands typeset. Each row maps a mono `\DIFadd{…}` / `\DIFdel{…}`
// source chip (left) to its rendered result (right) — additions blue/green and
// underlined, deletions red and struck through, a change as adjacent del+ins.
//
// Standalone (no MockupFrame): just the focused command→render card. The root
// carries `.mockup` so the shared `--mk-*` colour + dimensional tokens resolve
// and the card flips cleanly between the docs light / dark themes. The ins/del
// surfaces reuse the same rgba green/red + --mk-ins-text / --mk-del-text
// vocabulary as CompareHero's .dl ins / .dl del rules.
//
// `text` is split into static/marked/static spans so the mapping reads as a
// real sentence fragment, not a bare token.
const rows = [
  {
    kind: 'add',
    label: 'Addition',
    cmd: '\\DIFadd{efficient}',
    before: 'We present an ',
    mark: 'efficient',
    after: ' method',
  },
  {
    kind: 'del',
    label: 'Deletion',
    cmd: '\\DIFdel{novel and }',
    before: 'a ',
    mark: 'novel and ',
    after: 'efficient method',
  },
];
</script>

<template>
  <div
    class="mockup dm-card"
    role="group"
    aria-label="latexdiff markup mapping"
  >
    <div class="dm-head">
      <wa-icon class="dm-head-ic" library="texra" name="diff-single"></wa-icon>
      <span class="dm-head-name">latexdiff markup</span>
      <span class="dm-head-sub">source command · typeset result</span>
    </div>

    <ul class="dm-list">
      <li v-for="(r, i) in rows" :key="i" class="dm-row">
        <span class="dm-label" :class="`dm-label--${r.kind}`">{{
          r.label
        }}</span>
        <code class="dm-cmd"
          ><span class="dm-cmd-fn">{{
            r.cmd.slice(0, r.cmd.indexOf('{'))
          }}</span
          >{<span :class="`dm-cmd-arg dm-cmd-arg--${r.kind}`">{{ r.mark }}</span
          >}</code
        >
        <wa-icon class="dm-arrow" library="texra" name="arrow-right"></wa-icon>
        <span class="dm-render">
          <span class="dm-ctx">{{ r.before }}</span
          ><ins v-if="r.kind === 'add'">{{ r.mark }}</ins
          ><del v-else>{{ r.mark }}</del
          ><span class="dm-ctx">{{ r.after }}</span>
        </span>
      </li>

      <!-- A "change" is a deletion immediately followed by an addition. -->
      <li class="dm-row">
        <span class="dm-label dm-label--chg">Change</span>
        <code class="dm-cmd"
          ><span class="dm-cmd-fn">\DIFdel</span>{<span
            class="dm-cmd-arg dm-cmd-arg--del"
            >a graph</span
          >} <span class="dm-cmd-fn">\DIFadd</span>{<span
            class="dm-cmd-arg dm-cmd-arg--add"
            >a $d$-regular graph</span
          >}</code
        >
        <wa-icon class="dm-arrow" library="texra" name="arrow-right"></wa-icon>
        <span class="dm-render">
          <span class="dm-ctx">Let $G$ be </span><del>a graph</del
          ><ins>a $d$-regular graph</ins>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Standalone card. Tokens come from `.mockup` (theme/mockup.css). */
.dm-card {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

.dm-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
  font-family: var(--vp-font-family-mono);
}
.dm-head-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.dm-head-name {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.dm-head-sub {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}

.dm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.dm-row {
  display: grid;
  grid-template-columns: var(--mk-size-30) minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: var(--mk-space-10);
  padding: var(--mk-space-9) var(--mk-space-2);
}
.dm-row + .dm-row {
  border-top: 1px solid var(--mk-border);
}

.dm-label {
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.dm-label--add {
  color: var(--mk-ins-text);
}
.dm-label--del {
  color: var(--mk-del-text);
}
.dm-label--chg {
  color: var(--color-text-secondary);
}

.dm-cmd {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  color: var(--mk-text);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-sm);
  padding: var(--mk-space-3) var(--mk-space-7);
  white-space: pre-wrap;
  word-break: break-word;
}
.dm-cmd-fn {
  color: var(--mk-syn-fn);
}
.dm-cmd-arg--add {
  color: var(--mk-ins-text);
}
.dm-cmd-arg--del {
  color: var(--mk-del-text);
}

.dm-arrow {
  color: var(--mk-text-faint);
  font-size: var(--mk-space-13);
  justify-self: center;
}

.dm-render {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-82);
  line-height: 1.6;
  color: var(--wa-color-text-normal);
}
.dm-ctx {
  color: var(--color-text-secondary);
}
.dm-render ins {
  background: rgba(46, 160, 67, 0.28);
  color: var(--mk-ins-text);
  text-decoration: underline;
  border-radius: var(--mk-radius-xs);
  padding: 0 1px;
}
.dm-render del {
  background: rgba(241, 76, 76, 0.24);
  color: var(--mk-del-text);
  text-decoration: line-through;
  border-radius: var(--mk-radius-xs);
  padding: 0 1px;
}

/* Stack source command above its rendered result on narrow screens. */
@media (max-width: 640px) {
  .dm-row {
    grid-template-columns: var(--mk-size-30) 1fr;
    row-gap: var(--mk-space-6);
  }
  .dm-arrow {
    display: none;
  }
  .dm-cmd,
  .dm-render {
    grid-column: 2;
  }
  .dm-label {
    grid-row: span 2;
    align-self: start;
  }
}
</style>
