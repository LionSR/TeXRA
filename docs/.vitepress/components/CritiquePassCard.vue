<script setup>
// Frameless "Revision 2: review and correct" card. After the first revision,
// the edit program asks for a second one that checks the first against the
// original and the instruction (guide/workflows/polish-a-draft.md, "How the
// second revision works"). This card renders the four things that request
// names as icon + label rows so the reader sees the review at a glance.
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// (defined in theme/mockup.css on `.mockup`) resolve here and the card flips
// cleanly between the docs light / dark themes. Static strings only.
const checks = [
  {
    icon: 'target',
    label: 'Out-of-scope changes',
    note: 'reverts any change the instruction did not ask for',
  },
  {
    icon: 'symbol-operator',
    label: 'Missing math or reasoning',
    note: 'restores equations or steps dropped in the first revision',
  },
  {
    icon: 'symbol-variable',
    label: 'Notation before definition',
    note: 'fixes a symbol used before it is defined',
  },
  {
    icon: 'eye',
    label: 'Generic filler',
    note: 'removes sentences that say nothing specific',
    strike: 'provides crucial insights into…',
  },
];
</script>

<template>
  <div
    class="mockup mk-card crit"
    role="group"
    aria-label="Revision 2: review and correct"
  >
    <div class="mk-card-head crit-head">
      <wa-icon class="mk-card-head-ic" library="texra" name="search"></wa-icon>
      <span class="mk-card-title crit-head-name"
        >Revision 2: review and correct</span
      >
      <span class="mk-card-sub crit-head-sub"
        >rereads r0/intro.tex, then corrects it</span
      >
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
/* Card shell + inline mono header reuse the shared .mk-card* family
   (theme/mockup.css on `.mockup`). Only the deltas stay here: this card's
   header is base-font (mono lives only on the sub-line) with no bottom margin,
   and the title runs one step larger than the shared default. */
.crit-head {
  margin-bottom: 0;
  font-family: var(--vp-font-family-base);
}
.crit-head-name {
  font-size: var(--mk-fs-78);
}
.crit-head-sub {
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
  border-radius: var(--mk-radius-md);
}
.crit-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--mk-space-22);
  height: var(--mk-space-22);
  border-radius: var(--mk-radius-md);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
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
