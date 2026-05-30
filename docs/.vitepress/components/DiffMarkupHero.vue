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
    class="mockup mk-card dm-card"
    role="group"
    aria-label="latexdiff markup mapping"
  >
    <div class="mk-card-head dm-head">
      <wa-icon
        class="mk-card-head-ic"
        library="texra"
        name="diff-single"
      ></wa-icon>
      <span class="mk-card-title">latexdiff markup</span>
      <span class="mk-card-sub">source command · typeset result</span>
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
/* Card shell + inline mono header come from the shared .mk-card* family
   (theme/mockup.css). Only the deltas from those defaults live here. */
.dm-head {
  /* No gap between header and the first mapping row — drop the shared
     .mk-card-head bottom margin (the .dm-row top borders supply separation). */
  margin-bottom: 0;
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
  background: color-mix(in srgb, var(--color-success) 28%, transparent);
  color: var(--mk-ins-text);
  text-decoration: underline;
  border-radius: var(--mk-radius-xs);
  padding: 0 1px;
}
.dm-render del {
  background: color-mix(in srgb, var(--color-error) 24%, transparent);
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
