<script setup>
// Shared streaming-run card for headless `texra run` — the one terminal figure
// several guide pages reuse (quick-start, first-run, polish-a-draft,
// agent-architecture, multiple-output, working-with-figures, texra-cli), each
// with its own command and snapshot state. Workflow runs stream round progress
// and, in text mode, end by printing a filesystem path on stdout (the copied
// --output / --output-dir path, else the generated file in run storage) — so
// the card shows: prompt line, per-round progress rows, printed result lines,
// and an optional dim annotation. The round rows are a stylized view of the
// real progress signal — a single throttled live status line on stderr whose
// `[rN]` segment tracks the current round
// (packages/cli/src/runtime/runProgressRenderer.ts) — chosen so the r0/r1
// concept reads at a glance; captions should say rounds "stream as progress",
// not claim literal screen output.
//
// Built on the <TermWindow> primitive; .mockup-scoped, so the shared --mk-*
// tokens resolve here and the card flips with the docs light / dark theme.
// Props carry believable static page-specific strings — never live data:
// - command: full command line after `$ ` (flags are auto-tinted)
// - rounds:  [{ label, state: 'done' | 'active' }]
// - outputs: printed stdout result lines (paths), shown when the run finished
// - note:    optional dim trailing annotation
import { computed } from 'vue';

const props = defineProps({
  command: {
    type: String,
    default: 'texra run polish --input draft.tex',
  },
  rounds: {
    type: Array,
    default: () => [
      { label: 'r0 — draft revision', state: 'done' },
      { label: 'r1 — critique and revise', state: 'active' },
    ],
  },
  outputs: { type: Array, default: () => [] },
  note: { type: String, default: '' },
});

// Window title = the command's leading words ("texra run"), house convention.
const title = computed(() => props.command.split(' ').slice(0, 2).join(' '));

// Tint flag tokens without breaking quoted arguments apart.
const segments = computed(() => {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of props.command) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ' ') {
      if (cur) out.push(cur);
      out.push(' ');
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.map((text) => ({ text, flag: text.startsWith('-') }));
});
</script>

<template>
  <TermWindow :title="title" :aria-label="`${title} streaming output`">
    <!-- Prompt line, flags tinted -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd crh-cmd"
        ><template v-for="(s, i) in segments" :key="i"
          ><span v-if="s.flag" class="mk-term-flag">{{ s.text }}</span
          ><template v-else>{{ s.text }}</template></template
        ></span
      >
    </div>

    <!-- Round progress rows -->
    <ul class="crh-rounds">
      <li v-for="r in rounds" :key="r.label" class="crh-round">
        <wa-spinner
          v-if="r.state === 'active'"
          class="crh-spin mk-spinner"
        ></wa-spinner>
        <span v-else class="crh-dot"></span>
        <span class="crh-label">{{ r.label }}</span>
      </li>
    </ul>

    <!-- Printed result lines (text mode prints the output path on stdout) -->
    <div v-if="outputs.length" class="crh-outputs">
      <div v-for="line in outputs" :key="line" class="crh-out">{{ line }}</div>
    </div>

    <!-- Optional dim annotation -->
    <div v-if="note" class="crh-note">{{ note }}</div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt line come from TermWindow + the shared
   .mk-term-* classes in theme/mockup.css. */
.crh-cmd {
  white-space: pre-wrap;
  word-break: break-word;
}

.crh-rounds {
  list-style: none;
  margin: var(--mk-space-9) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.crh-round {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.crh-dot {
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  background: var(--color-success);
  flex-shrink: 0;
}
.crh-spin {
  font-size: var(--mk-space-11);
  flex-shrink: 0;
}
.crh-label {
  color: var(--mk-text-dim);
  font-size: var(--mk-fs-74);
}

.crh-outputs {
  margin-top: var(--mk-space-9);
}
.crh-out {
  color: var(--color-text-link);
  font-size: var(--mk-fs-74);
  word-break: break-all;
}

.crh-note {
  margin-top: var(--mk-space-8);
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-72);
  font-style: italic;
}
</style>
