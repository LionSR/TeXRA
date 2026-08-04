<script setup>
// Tiny terminal strip for the landing page's bottom CTA — the visual answer to
// "Can I use it without VS Code?". Three real commands (install, sign in, run)
// and the printed output path; nothing else. The editor-shaped hero carries the
// rest of the page, so this stays deliberately small.
//
// Built on the <TermWindow> primitive; .mockup-scoped and token-only, so it
// flips with the docs theme. Believable static strings.
const lines = [
  { cmd: 'npm install ', flag: '-g', rest: ' @texra-ai/cli' },
  { cmd: 'texra login', flag: '', rest: '' },
  { cmd: 'texra run polish ', flag: '--input', rest: ' paper.tex' },
];
</script>

<template>
  <TermWindow
    title="terminal"
    aria-label="Install, sign in, and run TeXRA from a terminal"
    class="lcs"
  >
    <div v-for="l in lines" :key="l.cmd" class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >{{ l.cmd }}<span v-if="l.flag" class="mk-term-flag">{{ l.flag }}</span
        >{{ l.rest }}</span
      >
    </div>
    <div class="lcs-out">executions/9f3a6c81d24e/r1/paper.tex</div>
  </TermWindow>
</template>

<style scoped>
.lcs {
  max-width: var(--mk-size-520);
  margin-left: auto;
  margin-right: auto;
  text-align: left;
}
.lcs-out {
  margin-top: var(--mk-space-5);
  color: var(--color-text-link);
  font-size: var(--mk-fs-72);
  word-break: break-all;
}
</style>
