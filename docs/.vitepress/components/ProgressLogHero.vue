<script setup>
// Frameless ProgressBoard log card. Makes the "Interpreting logs" colour key
// concrete: green = info / success, yellow = warning, red = error — the exact
// case where a colour-coded surface beats a prose list. No VS Code window
// chrome; the root carries `.mockup` so it inherits the --mk-* token block and
// flips with the docs light/dark theme.
//
// Row layout mirrors MemoryCommandsHero (.mc-row + a leading severity dot).
// Severity colours reuse the shared --color-success / --color-warning /
// --color-error tokens. The error row is expanded one level (a nested detail
// line) to illustrate "expand nested entries to see detailed information", and
// a task-id chip on one row illustrates "look for task IDs to track specific
// operations". Static strings only — never a live timestamp.

const filters = [
  { label: 'All', active: true },
  { label: 'Info', sev: 'info' },
  { label: 'Warn', sev: 'warn' },
  { label: 'Error', sev: 'error' },
];

const rows = [
  {
    sev: 'info',
    time: '14:02:11',
    msg: 'Run r0 started · spectral-gap.tex',
    task: '#a3f1',
  },
  {
    sev: 'success',
    time: '14:03:48',
    msg: 'Wrote r0/output.xml — 4 files',
  },
  {
    sev: 'warn',
    time: '14:05:02',
    msg: 'Approaching context window — 182k/200k tokens',
  },
  {
    sev: 'error',
    time: '14:05:39',
    msg: 'latexdiff exited 1 — see build log',
    detail: 'r0/build/diff.log:84  Undefined control sequence \\DIFadd',
  },
];

// Map a row severity to the label shown in the leading dot's column.
const sevTag = {
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERROR',
};
</script>

<template>
  <div class="mockup mk-card pblog" role="group" aria-label="ProgressBoard log">
    <div class="mk-card-head pb-head">
      <wa-icon
        class="mk-card-head-ic"
        library="texra"
        name="list-check"
      ></wa-icon>
      <span class="mk-card-title">ProgressBoard</span>
      <span class="mk-card-sub">log</span>
      <span class="pb-search">
        <wa-icon
          class="pb-search-ic"
          library="texra"
          name="magnifying-glass"
        ></wa-icon>
        <span class="pb-search-ph">Search log…</span>
      </span>
    </div>

    <div class="pb-filters">
      <span
        v-for="f in filters"
        :key="f.label"
        class="pb-filter"
        :class="[{ active: f.active }, f.sev ? `pb-filter--${f.sev}` : '']"
      >
        <span
          v-if="f.sev"
          class="pb-filter-dot"
          :class="`pb-dot--${f.sev}`"
        ></span>
        {{ f.label }}
      </span>
    </div>

    <ul class="pb-list">
      <li
        v-for="(r, i) in rows"
        :key="i"
        class="pb-row"
        :class="`pb-row--${r.sev}`"
      >
        <span class="pb-row-main">
          <span class="pb-dot" :class="`pb-dot--${r.sev}`"></span>
          <span class="pb-time">{{ r.time }}</span>
          <span class="pb-sev" :class="`pb-sev--${r.sev}`">{{
            sevTag[r.sev]
          }}</span>
          <span class="pb-msg">{{ r.msg }}</span>
          <code v-if="r.task" class="pb-task">{{ r.task }}</code>
        </span>
        <span v-if="r.detail" class="pb-detail">
          <wa-icon
            class="pb-detail-chev"
            library="texra"
            name="chevron-down"
          ></wa-icon>
          <code class="pb-detail-text">{{ r.detail }}</code>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Card shell + inline mono header inherit the shared .mk-card* family
   (theme/mockup.css). Only the values that differ are overridden below. */
.pblog {
  margin: var(--mk-space-16) 0;
}

/* This header keeps the base font and has no bottom margin (the filter row
   below already supplies its own top padding). */
.pb-head {
  margin-bottom: 0;
  font-family: var(--vp-font-family-base);
}
.pb-search {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-6);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-3) var(--mk-space-8);
  min-width: 0;
}
.pb-search-ic {
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
  flex-shrink: 0;
}
.pb-search-ph {
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
}

/* Filter pill row. */
.pb-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
  padding: var(--mk-space-9) 0 var(--mk-space-7);
}
.pb-filter {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-pill, 999px);
  padding: var(--mk-space-2) var(--mk-space-9);
}
.pb-filter.active {
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  border-color: var(--mk-accent);
  color: var(--mk-text);
  font-weight: 600;
}
.pb-filter-dot {
  width: var(--mk-space-7);
  height: var(--mk-space-7);
  border-radius: 50%;
  flex-shrink: 0;
}

/* Log rows. */
.pb-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}
.pb-row {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
  padding: var(--mk-space-6) var(--mk-space-6);
  border-radius: var(--mk-radius-md);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  line-height: 1.5;
}
.pb-row--error {
  background: rgba(220, 90, 90, 0.07);
}
.pb-row-main {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}

.pb-dot {
  align-self: center;
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  flex-shrink: 0;
}
.pb-dot--info,
.pb-dot--success {
  background: var(--color-success);
}
.pb-dot--warn {
  background: var(--color-warning);
}
.pb-dot--error {
  background: var(--color-error);
}

.pb-time {
  color: var(--mk-text-faint);
  flex-shrink: 0;
}
.pb-sev {
  font-size: var(--mk-fs-66);
  font-weight: 700;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.pb-sev--info,
.pb-sev--success {
  color: var(--color-success);
}
.pb-sev--warn {
  color: var(--color-warning);
}
.pb-sev--error {
  color: var(--color-error);
}

.pb-msg {
  color: var(--mk-text);
  min-width: 0;
}
.pb-task {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-size: var(--mk-fs-70);
  flex-shrink: 0;
}

/* Expanded nested detail line under the error row. */
.pb-detail {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-6);
  padding-left: var(--mk-space-16);
}
.pb-detail-chev {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  flex-shrink: 0;
}
.pb-detail-text {
  color: var(--color-text-secondary);
  font-size: var(--mk-fs-72);
  word-break: break-all;
  min-width: 0;
}

@media (max-width: 560px) {
  .pb-search {
    display: none;
  }
}
</style>
