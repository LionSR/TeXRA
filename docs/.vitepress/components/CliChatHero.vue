<script setup>
// Frameless terminal-window card for `texra chat` — the interactive tool-use
// TUI described in guide/texra-cli.md. The CLI is a terminal product, so this
// shows what a compressed session actually looks like: a faux prompt line, a
// user turn, a streaming "reasoning" line with a bridged <wa-spinner>, two
// tool-call rows (the MemoryCommandsHero status-dot + tool + verb-chip + path
// vocabulary), an inline diff hunk (CompareHero's ins/del styling), and a
// bottom hint strip listing the slash commands `/tools` `/api` `/resume`.
//
// Standalone (no MockupFrame) — just the terminal card on the .mockup surface,
// so the shared --mk-* tokens resolve here and the whole thing flips with the
// docs light / dark theme. Believable static strings only; no live dates.

// Tool-call rows mirror MemoryCommandsHero: status dot + tool + verb chip +
// path + one-line effect. The last row is `active` (in-flight spinner).
const calls = [
  {
    state: 'done',
    tool: 'read_file',
    verb: 'read',
    path: 'sections/intro.tex',
    effect: 'Reads the opening paragraph',
  },
  {
    state: 'active',
    tool: 'edit_file',
    verb: 'edit',
    path: 'sections/intro.tex',
    effect: 'Tightens the motivating sentence',
  },
];
</script>

<template>
  <div class="mockup cli-chat" role="group" aria-label="texra chat session">
    <!-- Faux terminal titlebar: traffic-light dots + window title -->
    <div class="cc-bar">
      <span class="cc-light cc-light--r"></span>
      <span class="cc-light cc-light--y"></span>
      <span class="cc-light cc-light--g"></span>
      <span class="cc-title">texra chat</span>
    </div>

    <div class="cc-body">
      <!-- Prompt line that launched the session -->
      <div class="cc-prompt">
        <span class="cc-sigil">$</span>
        <span class="cc-cmd"
          >texra chat <span class="cc-flag">--agent</span> research</span
        >
      </div>

      <!-- User turn -->
      <div class="cc-turn cc-turn--user">
        <span class="cc-who cc-who--user">you</span>
        <span class="cc-msg"
          >Polish the introduction and fix the awkward opener.</span
        >
      </div>

      <!-- Streaming assistant reasoning line (in-flight spinner) -->
      <div class="cc-turn cc-turn--ai">
        <span class="cc-who cc-who--ai">research</span>
        <wa-spinner class="cc-spin mk-spinner"></wa-spinner>
        <span class="cc-reasoning"
          >Reading the section, then rewriting the first sentence…</span
        >
      </div>

      <!-- Tool-call rows -->
      <ul class="cc-tools">
        <li
          v-for="(c, i) in calls"
          :key="i"
          class="cc-tool-row"
          :class="{ active: c.state === 'active' }"
        >
          <wa-spinner
            v-if="c.state === 'active'"
            class="cc-tspin mk-spinner"
          ></wa-spinner>
          <span v-else class="cc-dot"></span>
          <span class="cc-tname">{{ c.tool }}</span>
          <code class="cc-verb">{{ c.verb }}</code>
          <span class="cc-path">{{ c.path }}</span>
          <span class="cc-effect">{{ c.effect }}</span>
        </li>
      </ul>

      <!-- Inline diff hunk (the change edit_file is making) -->
      <div class="cc-diff">
        <div class="cc-dl cc-dl--del">
          <span class="cc-gut">−</span>
          <span class="cc-code"
            ><del>In this paper we present a novel approach to</del></span
          >
        </div>
        <div class="cc-dl cc-dl--add">
          <span class="cc-gut">+</span>
          <span class="cc-code"><ins>We introduce</ins></span>
        </div>
      </div>
    </div>

    <!-- Slash-command hint strip -->
    <div class="cc-hint">
      <span class="cc-hint-label">slash commands</span>
      <code class="cc-slash">/tools</code>
      <code class="cc-slash">/api</code>
      <code class="cc-slash">/resume</code>
    </div>
  </div>
</template>

<style scoped>
/* Standalone terminal card. Tokens come from `.mockup` (theme/mockup.css). */
.cli-chat {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-12) 0;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

/* Titlebar */
.cc-bar {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-7) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border);
}
.cc-light {
  width: var(--mk-space-9);
  height: var(--mk-space-9);
  border-radius: 50%;
  flex-shrink: 0;
}
.cc-light--r {
  background: var(--color-error);
}
.cc-light--y {
  background: var(--color-warning);
}
.cc-light--g {
  background: var(--color-success);
}
.cc-title {
  margin-left: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
}

/* Terminal body */
.cc-body {
  padding: var(--mk-space-12) var(--mk-space-14);
  background: var(--mk-bg-deep);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  line-height: 1.6;
  color: var(--wa-color-text-normal);
}

.cc-prompt {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
}
.cc-sigil {
  color: var(--mk-syn-fn);
  font-weight: 600;
  flex-shrink: 0;
}
.cc-cmd {
  color: var(--mk-text);
}
.cc-flag {
  color: var(--mk-syn-comment);
}

/* Conversation turns */
.cc-turn {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-9);
}
.cc-who {
  flex-shrink: 0;
  font-size: var(--mk-fs-70);
  font-weight: 600;
  padding: 0 var(--mk-space-5);
  border-radius: var(--mk-radius-sm);
}
.cc-who--user {
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--mk-accent) 5%, transparent);
}
.cc-who--ai {
  color: var(--mk-syn-fn);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
}
.cc-msg {
  color: var(--mk-text);
  min-width: 0;
  flex: 1;
}
.cc-reasoning {
  color: var(--mk-text-faint);
  font-style: italic;
  min-width: 0;
  flex: 1;
}
/* Bridged Web Awesome spinner; track/indicator colors flip with the theme. */
.cc-spin {
  align-self: center;
  font-size: var(--mk-space-11);
  flex-shrink: 0;
}

/* Tool-call rows */
.cc-tools {
  list-style: none;
  margin: var(--mk-space-9) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}
.cc-tool-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  padding: var(--mk-space-5) var(--mk-space-6);
  border-radius: var(--mk-radius-md);
  font-size: var(--mk-fs-74);
  line-height: 1.5;
}
.cc-tool-row.active {
  background: color-mix(in srgb, var(--mk-accent) 8%, transparent);
}
.cc-dot {
  align-self: center;
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  background: var(--color-success);
  flex-shrink: 0;
}
.cc-tspin {
  align-self: center;
  font-size: var(--mk-space-11);
  flex-shrink: 0;
}
.cc-tname {
  color: var(--mk-syn-fn);
  font-weight: 600;
  flex-shrink: 0;
}
.cc-verb {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
  font-size: var(--mk-fs-72);
  flex-shrink: 0;
}
.cc-path {
  color: var(--color-text-link);
  word-break: break-all;
  min-width: 0;
}
.cc-effect {
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-72);
  flex: 1;
  min-width: 0;
}

/* Inline diff hunk */
.cc-diff {
  margin-top: var(--mk-space-9);
  padding: var(--mk-space-6) 0;
  border-top: 1px solid var(--mk-border);
}
.cc-dl {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-10);
  white-space: pre-wrap;
  font-size: var(--mk-fs-74);
  line-height: 1.7;
}
.cc-dl--del {
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
}
.cc-dl--add {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
}
.cc-gut {
  flex-shrink: 0;
  width: var(--mk-size-21);
  text-align: center;
  color: var(--color-text-tertiary);
  user-select: none;
}
.cc-code {
  min-width: 0;
}
.cc-dl del {
  color: var(--mk-del-text);
  text-decoration: line-through;
}
.cc-dl ins {
  color: var(--mk-ins-text);
  text-decoration: none;
}

/* Slash-command hint strip */
.cc-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  padding: var(--mk-space-8) var(--mk-space-14);
  background: var(--mk-bg-soft);
  border-top: 1px solid var(--mk-border);
}
.cc-hint-label {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  margin-right: var(--mk-space-4);
}
.cc-slash {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-pill);
  padding: 0 var(--mk-space-8);
}

/* Stack effect under verb/path on narrow screens. */
@media (max-width: 560px) {
  .cc-effect {
    flex-basis: 100%;
    padding-left: var(--mk-space-16);
  }
}
</style>
