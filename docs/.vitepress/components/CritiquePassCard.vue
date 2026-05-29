<script setup>
// Frameless "Round 1 — critique pass" card. After Round 0 writes a revision,
// polish re-prompts itself to scan for the failure modes enumerated in
// guide/workflows/polish-a-draft.md ("How the critique pass works"). This card
// renders that checklist as five icon + label rows so the reader sees the
// review at a glance instead of parsing a prose bullet list.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// (defined in theme/mockup.css on `.mockup`) resolve here and the card flips
// cleanly between the docs light / dark themes. Static strings only.
const checks = [
  {
    icon: 'shield',
    label: 'Weakened edits',
    note: 'reverts changes that dulled the original argument',
  },
  {
    icon: 'symbol-operator',
    label: 'Missing math',
    note: 'restores equations or symbols dropped in Round 0',
  },
  {
    icon: 'symbol-variable',
    label: 'Notation before definition',
    note: 'flags a symbol used before it is introduced',
  },
  {
    icon: 'eye',
    label: 'Generic filler',
    note: 'cuts empty phrasing',
    strike: 'provides crucial insights into…',
  },
  {
    icon: 'target',
    label: 'Out-of-scope changes',
    note: 'keeps edits inside your instruction',
  },
];
</script>

<template>
  <div class="mockup crit" role="group" aria-label="Round 1 critique pass">
    <div class="crit-head">
      <wa-icon class="crit-head-ic" library="texra" name="search"></wa-icon>
      <span class="crit-head-name">Round 1 — critique pass</span>
      <span class="crit-head-sub">rereads r0/intro.tex, then revises</span>
    </div>
    <ul class="crit-list">
      <li v-for="(c, i) in checks" :key="i" class="crit-item">
        <span class="crit-ic">
          <wa-icon library="texra" :name="c.icon"></wa-icon>
        </span>
        <span class="crit-body">
          <span class="crit-label">{{ c.label }}</span>
          <span class="crit-note">
            {{ c.note
            }}<template v-if="c.strike">
              <del class="crit-strike">{{ c.strike }}</del></template
            >
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Standalone frameless card. Tokens come from `.mockup` (theme/mockup.css). */
.crit {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
  overflow: hidden;
}

.crit-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
}
.crit-head-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.crit-head-name {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--mk-text);
}
.crit-head-sub {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-mono);
}

.crit-list {
  list-style: none;
  margin: var(--mk-space-8) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-5);
}
.crit-item {
  display: flex;
  align-items: flex-start;
  gap: var(--mk-space-10);
  padding: var(--mk-space-8) var(--mk-space-10);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
}
.crit-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--mk-space-22);
  height: var(--mk-space-22);
  border-radius: var(--mk-radius-md);
  background: rgba(200, 155, 224, 0.13);
  color: var(--mk-accent);
  font-size: var(--mk-fs-80);
}
.crit-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  min-width: 0;
}
.crit-label {
  font-size: var(--mk-fs-82);
  font-weight: 600;
  color: var(--mk-text);
}
.crit-note {
  font-size: var(--mk-fs-76);
  color: var(--color-text-secondary);
}
.crit-strike {
  margin-left: var(--mk-space-4);
  color: var(--mk-del-text);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  text-decoration: line-through;
}
</style>
