<script setup>
// Terminal card for guide/file-management.md "Task Run Storage" —
// StorageLifecycleFlow's terminal twin. Three beats showing the same
// storage-first lifecycle from the CLI: (1) a bare run prints its run-storage
// path (outputs land in storage first, never over workspace files), (2)
// `--output` copies the final artifact out — the CLI's "Accept", (3)
// `texra history show <id>` lists the run's stored artifacts with the real
// `Files (N):` `<size>\t<path>` format (packages/cli/src/runtime/history.ts
// formatCliHistoryDetailsText). The CLI shares the host-neutral run store at
// `executions/<executionId>/` under TeXRA's workspace storage; ids are
// 12-char hex.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
const files = [
  { size: '4128', path: 'r0/paper.tex' },
  { size: '4310', path: 'r1/paper.tex' },
];
</script>

<template>
  <TermWindow
    title="texra run"
    aria-label="Run storage lifecycle from the terminal"
  >
    <!-- Beat 1: storage first -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra run polish
        <span class="mk-term-flag">--input</span> paper.tex</span
      >
    </div>
    <div class="csh-out">…/executions/9f3a6c81d24e/r1/paper.tex</div>
    <div class="csh-note">outputs land in the run's storage folder first</div>

    <!-- Beat 2: copy out on request (the CLI's "Accept") -->
    <div class="mk-term-prompt csh-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra run polish <span class="mk-term-flag">--input</span> paper.tex
        <span class="mk-term-flag">--output</span> paper.polished.tex</span
      >
    </div>
    <div class="csh-out">paper.polished.tex</div>
    <div class="csh-note">
      --output copies the final artifact next to your input
    </div>

    <!-- Beat 3: browse a run's stored artifacts -->
    <div class="mk-term-prompt csh-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra history show 9f3a6c81d24e</span>
    </div>
    <div class="csh-files">
      <div class="csh-elide">
        … Execution / Status / Agent / Model details …
      </div>
      <div class="csh-files-head">Files (2):</div>
      <div v-for="f in files" :key="f.path" class="csh-file">
        <span class="csh-size">{{ f.size }}</span>
        <span class="csh-path">{{ f.path }}</span>
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.csh-beat {
  margin-top: var(--mk-space-10);
  flex-wrap: wrap;
}
.csh-out {
  margin-top: var(--mk-space-4);
  color: var(--color-text-link);
  font-size: var(--mk-fs-72);
  word-break: break-all;
}
.csh-note {
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-70);
  font-style: italic;
}

.csh-files {
  margin-top: var(--mk-space-5);
  padding-left: var(--mk-space-16);
  font-size: var(--mk-fs-72);
}
.csh-elide {
  color: var(--mk-text-faint);
  font-style: italic;
  font-size: var(--mk-fs-70);
}
.csh-files-head {
  color: var(--mk-text-dim);
  font-weight: 600;
}
.csh-file {
  display: flex;
  gap: var(--mk-space-12);
}
.csh-size {
  color: var(--mk-text-faint);
  min-width: var(--mk-size-32);
  text-align: right;
}
.csh-path {
  color: var(--color-text-link);
}
</style>
