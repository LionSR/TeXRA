<script setup>
// The live side-panel a `codex` / `claude_code` hand-off opens on the
// ProgressBoard: a stream tab labelled `claude_code` that streams the
// delegated agent's reasoning, the commands it runs, file changes, web
// searches, and todos — then shows WAITING when the turn ends, with a Stop
// control. The final message + token cost hand back to the calling TeXRA agent.
//
// Standalone (frameless) — just the stream column, no MockupFrame / dash-nav.
// Reuses the shared .stream-head / .tcard / .todos vocabulary from theme/
// mockup.css plus the StatusPill primitive for the WAITING tag; the root carries
// `.mockup` so `--mk-*` tokens resolve and
// the panel flips with the docs light / dark theme. Static strings only.
import StatusPill from './StatusPill.vue';
</script>

<template>
  <aside
    class="mockup ds-stream"
    role="group"
    aria-label="delegated agent stream panel"
  >
    <!-- Stream head: tab name · Stop · turn/tool-call badge -->
    <div class="stream-head">
      <span class="sh-name">claude_code</span>
      <span class="sh-dot" title="Running"></span>
      <span class="sh-badge">1 turn · 6 tool calls</span>
      <span class="sh-tools">
        <wa-icon
          class="shi"
          library="texra"
          name="circle-stop"
          title="Stop"
        ></wa-icon>
      </span>
    </div>

    <div class="board-scroll">
      <!-- Reasoning line (muted) -->
      <div class="ds-reason">
        Adding the <code>--dry-run</code> flag to <code>build.py</code> and a
        test that asserts no files are written…
      </div>

      <!-- Command / tool-use card -->
      <div class="tcard ds-row">
        <wa-icon class="tc-ic" library="texra" name="terminal"></wa-icon>
        <span class="tc-label"
          ><span class="tc-tool">bash</span> —
          <code class="ds-cmd">pytest -q</code></span
        >
        <wa-icon class="ds-ok" library="texra" name="check"></wa-icon>
      </div>

      <!-- File-change row with +/- counts -->
      <div class="tcard ds-row">
        <wa-icon class="tc-ic" library="texra" name="file-code"></wa-icon>
        <span class="tc-label"
          ><span class="tc-tool">edit</span>
          <span class="ds-file">build.py</span></span
        >
        <span class="ds-counts"
          ><span class="ds-add">+14</span><span class="ds-del">−2</span></span
        >
      </div>

      <!-- Web-search row -->
      <div class="tcard ds-row">
        <wa-icon class="tc-ic ds-globe" library="texra" name="globe"></wa-icon>
        <span class="tc-label"
          ><span class="tc-tool">web_search</span> — argparse mutually exclusive
          flags</span
        >
      </div>

      <!-- Compact todos panel -->
      <div class="ds-panel">
        <div class="ds-panel-sum">
          <wa-icon class="chev" library="texra" name="chevron-down"></wa-icon>
          Todos (2/3)
        </div>
        <div class="todos ds-todos">
          <div class="todo done">
            <wa-icon class="td-ic" library="texra" name="check"></wa-icon
            ><span class="td-tx"
              >Add <code>--dry-run</code> to the arg parser</span
            >
          </div>
          <div class="todo done">
            <wa-icon class="td-ic" library="texra" name="check"></wa-icon
            ><span class="td-tx">Guard file writes behind the flag</span>
          </div>
          <div class="todo prog">
            <span class="td-sp"></span
            ><span class="td-tx">Update the build-script tests</span>
          </div>
        </div>
      </div>

      <!-- Turn-end state: WAITING + follow-up affordance -->
      <div class="ds-foot">
        <StatusPill variant="warning">WAITING</StatusPill>
        <span class="ds-hint">Type to send a follow-up</span>
      </div>

      <!-- Hand-back to the calling TeXRA agent -->
      <div class="ds-deliver">
        <wa-icon class="ds-deliver-ic" library="texra" name="reply"></wa-icon>
        <span
          >Returned to <code>research</code> agent — 1 message · 8.2K
          tokens</span
        >
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* Frameless stream column. .stream-head / .tcard / .todos primitives come from
   theme/mockup.css (.mockup scope) and the WAITING tag uses StatusPill; this
   file adds only the bits unique to a delegated session. */
.ds-stream {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) 0;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

/* Give the borrowed .stream-head a little breathing room as a standalone strip. */
.ds-stream .stream-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-8) var(--mk-space-12);
  border-bottom: 1px solid var(--mk-border);
}

.board-scroll {
  padding: var(--mk-space-10) var(--mk-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
}

.ds-reason {
  color: var(--mk-text-dim);
  font-style: italic;
  line-height: 1.5;
  font-size: var(--mk-fs-78);
}
.ds-reason code,
.ds-deliver code {
  font-family: var(--vp-font-family-mono);
  font-style: normal;
  font-size: var(--mk-fs-70);
  color: var(--color-text-link);
}

/* Tool / command / file-change rows reuse .tcard but sit flush, no hover-grow */
.ds-row {
  cursor: default;
  gap: var(--mk-space-7);
}
.ds-row:hover {
  background: none;
}
.ds-cmd {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
}
.ds-file {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--color-text-link);
}
.ds-ok {
  flex-shrink: 0;
  color: var(--color-success);
  font-size: var(--mk-space-12);
}
.ds-globe {
  color: var(--mk-syn-fn);
}
.ds-counts {
  display: inline-flex;
  gap: var(--mk-space-6);
  flex-shrink: 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
}
.ds-add {
  color: var(--mk-ins-text);
}
.ds-del {
  color: var(--mk-del-text);
}

/* Compact todos panel */
.ds-panel {
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-6) var(--mk-space-10);
}
.ds-panel-sum {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  font-weight: 600;
  font-size: var(--mk-fs-74);
  color: var(--wa-color-text-normal);
}
.ds-panel-sum .chev {
  font-size: var(--mk-space-11);
  color: var(--color-text-tertiary);
}
.ds-todos {
  margin-top: var(--mk-space-5);
  font-size: var(--mk-fs-74);
}
.ds-todos code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-68);
  color: var(--color-text-link);
}

/* Turn-end state */
.ds-foot {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding-top: var(--mk-space-2);
}
.ds-hint {
  font-size: var(--mk-fs-72);
  color: var(--color-text-tertiary);
}

/* Hand-back delivery line */
.ds-deliver {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding-top: var(--mk-space-7);
  border-top: 1px solid var(--mk-border);
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
}
.ds-deliver-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-accent);
  flex-shrink: 0;
}
</style>
