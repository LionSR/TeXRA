<script setup>
// Parity card for guide/index.md "Two surfaces, one system" — the page's
// strongest CLI claim ("A run started in the CLI shows up in the extension's
// Progress Board, and vice versa") made visible: the SAME run, identified by
// the same 12-char hex execution id, seen from both surfaces. Left half is a
// slim terminal strip (shared .mk-term-* chrome from theme/mockup.css); right
// half is a single Progress-Board-style stream row (GuideIntroHero's
// stream-head vocabulary, reduced to one row). The shared id chip is the
// visual tie.
//
// .mockup-scoped and token-only, so both halves flip with the docs theme.
// Halves stack under the shared 820px breakpoint. Believable static strings.
const RUN_ID = '9f3a6c81d24e';
</script>

<template>
  <div
    class="mockup rph"
    role="group"
    aria-label="One run visible from both the CLI and the extension's Progress Board"
  >
    <!-- Terminal half: the run as the CLI shows it -->
    <section class="mk-term-card rph-term">
      <div class="mk-term-bar">
        <span class="mk-term-light mk-term-light--r"></span>
        <span class="mk-term-light mk-term-light--y"></span>
        <span class="mk-term-light mk-term-light--g"></span>
        <span class="mk-term-title">terminal</span>
      </div>
      <div class="mk-term-body rph-term-body">
        <div class="mk-term-prompt">
          <span class="mk-term-sigil">$</span>
          <span class="mk-term-cmd"
            >texra run polish
            <span class="mk-term-flag">--input</span> draft.tex</span
          >
        </div>
        <div class="rph-done">
          <span class="rph-dot"></span>
          <span>run complete</span>
          <code class="rph-id">{{ RUN_ID }}</code>
        </div>
        <div class="rph-path">executions/{{ RUN_ID }}/r1/draft.tex</div>
      </div>
    </section>

    <!-- Connector: same run, either surface -->
    <div class="rph-link" aria-hidden="true">
      <span class="rph-link-glyph">⇄</span>
      <span class="rph-link-label">same run</span>
    </div>

    <!-- Progress-Board half: the same run as the extension shows it -->
    <section class="mk-term-card rph-board">
      <div class="rph-board-head">
        <wa-icon library="texra" name="robot"></wa-icon>
        <span>Progress</span>
      </div>
      <div class="rph-row">
        <span class="rph-dot"></span>
        <span class="rph-agent">polish</span>
        <span class="rph-file">draft.tex</span>
        <code class="rph-id">{{ RUN_ID }}</code>
      </div>
      <div class="rph-row-sub">completed — diff ready on r1/draft.tex</div>
    </section>
  </div>
</template>

<style scoped>
.rph {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  gap: var(--mk-space-10);
  margin: var(--mk-space-12) 0;
}

/* Both halves take their shell from the shared .mk-term-card class
   (theme/mockup.css); only layout-specific bits live here. */
.rph-term-body {
  font-size: var(--mk-fs-74);
}
/* Annotation, not terminal output: text mode prints only the path (the id is
   inside it) — this row just names the run for the parity tie. */
.rph-done {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-8);
  color: var(--mk-text-faint);
  font-style: italic;
  font-size: var(--mk-fs-72);
}
.rph-path {
  margin-top: var(--mk-space-5);
  color: var(--color-text-link);
  word-break: break-all;
  font-size: var(--mk-fs-72);
}

/* Connector */
.rph-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--mk-space-3);
  color: var(--mk-text-faint);
}
.rph-link-glyph {
  color: var(--mk-accent);
  font-size: var(--mk-fs-105);
}
.rph-link-label {
  font-size: var(--mk-fs-66);
  white-space: nowrap;
}

/* Progress-Board half */
.rph-board {
  display: flex;
  flex-direction: column;
}
.rph-board-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-7) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border);
  font-size: var(--mk-fs-72);
  font-weight: 600;
  color: var(--mk-text-dim);
}
.rph-board-head wa-icon {
  font-size: var(--mk-space-12);
  color: var(--mk-accent);
}
.rph-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  padding: var(--mk-space-9) var(--mk-space-12) 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
}
.rph-agent {
  color: var(--mk-syn-fn);
  font-weight: 600;
}
.rph-file {
  color: var(--mk-text);
}
.rph-row-sub {
  padding: var(--mk-space-4) var(--mk-space-12) var(--mk-space-10);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
}

/* Shared vocabulary across both halves */
.rph-dot {
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  background: var(--color-success);
  flex-shrink: 0;
}
.rph-id {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-68);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
}

/* Stack the halves on narrow screens; rotate the connector inline. */
@media (max-width: 820px) {
  .rph {
    grid-template-columns: 1fr;
  }
  .rph-link {
    flex-direction: row;
    gap: var(--mk-space-7);
  }
}
</style>
