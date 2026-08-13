<script setup>
// Compact, props-driven slice of the real `texra doctor` text report — the
// terminal twin of DoctorReportCard (installation.md), for pages that need a
// few toolchain rows rather than the whole stylized report. Rows reproduce the
// CLI's literal output format (packages/cli/src/runtime/doctor.ts
// formatDoctorText): `PASS <name>: <message>` with a dim indented hint line
// under WARN/FAIL rows, exactly as the command prints them. LaTeX row names
// and purposes come from src/latex/latexToolchain.ts TOOL_PURPOSES.
//
// Built on <TermWindow>; .mockup-scoped and token-only, so it flips with the
// docs theme. Pages pass their own rows: { state: 'pass'|'warn'|'fail',
// name, message, hint? }.
defineProps({
  rows: { type: Array, required: true },
});
</script>

<template>
  <TermWindow title="texra doctor" aria-label="texra doctor report excerpt">
    <div class="mk-term-prompt dsh-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra doctor</span>
    </div>
    <ul class="dsh-rows">
      <li v-for="r in rows" :key="r.name" class="dsh-row">
        <div class="dsh-line">
          <span class="dsh-state" :class="`dsh-state--${r.state}`">{{
            r.state.toUpperCase()
          }}</span>
          <span class="dsh-name">{{ r.name }}:</span>
          <span class="dsh-msg">{{ r.message }}</span>
        </div>
        <div v-if="r.hint" class="dsh-hint">{{ r.hint }}</div>
      </li>
    </ul>
    <div class="dsh-more">
      … plus Node.js, workspace dirs, auth, model access, and config checks
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.dsh-prompt {
  margin-bottom: var(--mk-space-8);
}
.dsh-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-3);
}
.dsh-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  font-size: var(--mk-fs-74);
}
.dsh-state {
  font-weight: 700;
  flex-shrink: 0;
}
.dsh-state--pass {
  color: var(--color-success);
}
.dsh-state--warn {
  color: var(--color-warning);
}
.dsh-state--fail {
  color: var(--color-error);
}
.dsh-name {
  color: var(--mk-text);
  font-weight: 600;
}
.dsh-msg {
  color: var(--mk-text-dim);
  min-width: 0;
}
.dsh-hint {
  padding-left: var(--mk-space-26);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
.dsh-more {
  margin-top: var(--mk-space-8);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
  font-style: italic;
}
</style>
