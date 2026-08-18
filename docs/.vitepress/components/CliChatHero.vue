<script setup>
// Terminal-window card for `texra chat` — the interactive tool-use TUI
// described in guide/texra-cli.md. Built on the <TermWindow> primitive and
// fact-checked against the real TUI sources so the figure shows what the
// session actually renders (packages/cli/src/chat/tui/panes/
// StaticConversationTranscript.tsx, toolRenderers.tsx, StatusBar.tsx):
// the once-printed session header (`{ T } TeXRA` + version + access route over
// a rule, then `agent: … · model: …`), a reverse-video user band prefixed `› `
// (no speaker chips), plain assistant text, `● tool (preview)` call rows whose
// status dot is dim while running and green when done, dim `⎿ ` output lines,
// and an edit rendered as full-width +/− diff bands (never strikethrough).
// The bottom strip mirrors the status bar: ◆ status · access route · round
// counter · token usage.
//
// .mockup-scoped, so the shared --mk-* tokens resolve here and the whole card
// flips with the docs light / dark theme. Believable static strings only.
const calls = [
  {
    state: 'done',
    tool: 'read_file',
    preview: 'sections/intro.tex',
    output: 'In this paper we present a novel approach to',
    more: '… +41 lines (ctrl + t to view transcript)',
  },
  {
    state: 'running',
    tool: 'edit_file',
    preview: 'sections/intro.tex',
  },
];
</script>

<template>
  <TermWindow title="texra chat" aria-label="texra chat session">
    <!-- Shell prompt that launched the session -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra chat <span class="mk-term-flag">--agent</span> research</span
      >
    </div>

    <!-- Session header: printed once at the top of every chat session -->
    <div class="cc-header">
      <div class="cc-brand-row">
        <span class="cc-brand">{ T } TeXRA</span>
        <span class="cc-meta">v0.38.8</span>
        <span class="cc-meta">API keys</span>
      </div>
      <div class="cc-identity">agent: research · model: deepseekT</div>
    </div>

    <!-- User turn: reverse-video band with the `› ` chevron, no name chip -->
    <div class="cc-user">
      <span class="cc-chevron">›</span>
      <span class="cc-user-msg"
        >Polish the introduction and fix the awkward opener.</span
      >
    </div>

    <!-- Assistant turn: plain unlabeled text -->
    <p class="cc-assistant">Reading the section, then tightening the opener.</p>

    <!-- Tool-call rows: ● tool (preview); dot dim while running, green done -->
    <ul class="cc-tools">
      <li v-for="c in calls" :key="c.tool" class="cc-call">
        <div class="cc-call-row">
          <span
            class="cc-dot"
            :class="c.state === 'done' ? 'cc-dot--done' : 'cc-dot--running'"
            >●</span
          >
          <span class="cc-tname">{{ c.tool }}</span>
          <span class="cc-preview">({{ c.preview }})</span>
        </div>
        <div v-if="c.output" class="cc-out">
          <span class="cc-corner">⎿</span>
          <span class="cc-out-text">{{ c.output }}</span>
        </div>
        <div v-if="c.more" class="cc-out cc-out--more">
          <span class="cc-out-text">{{ c.more }}</span>
        </div>
      </li>
    </ul>

    <!-- The edit in flight, as the TUI's full-width diff bands -->
    <div class="cc-diff">
      <div class="cc-out">
        <span class="cc-corner">⎿</span>
        <span class="cc-out-text">sections/intro.tex</span>
      </div>
      <div class="cc-dl cc-dl--del">
        <span class="cc-gut">-</span>
        <span class="cc-code"
          >In this paper we present a novel approach to</span
        >
      </div>
      <div class="cc-dl cc-dl--add">
        <span class="cc-gut">+</span>
        <span class="cc-code">We introduce</span>
      </div>
    </div>

    <!-- Status-bar strip: ◆ status · elapsed · access route · round · tokens -->
    <template #hint>
      <span class="cc-diamond">◆</span>
      <span class="cc-status">running</span>
      <span class="cc-seg">8s</span>
      <span class="cc-seg">API keys</span>
      <span class="cc-seg">r1</span>
      <span class="cc-seg">12.3k/1M (1%)</span>
      <span class="cc-bindings"
        >[/model]models&ensp;[/api]api&ensp;[Ctrl-C]stop</span
      >
    </template>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, prompt line, and hint strip come from TermWindow and the
   shared .mk-term-* classes in theme/mockup.css. */

/* Session header */
.cc-header {
  margin-top: var(--mk-space-9);
  padding-top: var(--mk-space-7);
  border-top: 1px solid var(--mk-border);
}
.cc-brand-row {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-10);
}
.cc-brand {
  color: var(--mk-accent);
  font-weight: 700;
}
.cc-meta {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
.cc-identity {
  color: var(--mk-text-dim);
  font-size: var(--mk-fs-74);
}

/* User band: the TUI's reverse-video message highlight */
.cc-user {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-9);
  padding: var(--mk-space-4) var(--mk-space-8);
  border-radius: var(--mk-radius-sm);
  background: var(--mk-bg-raised);
}
.cc-chevron {
  color: var(--mk-accent);
  font-weight: 700;
  flex-shrink: 0;
}
.cc-user-msg {
  color: var(--mk-text);
  min-width: 0;
}

/* Assistant text */
.cc-assistant {
  margin: var(--mk-space-9) 0 0;
  color: var(--mk-text);
}

/* Tool-call rows */
.cc-tools {
  list-style: none;
  margin: var(--mk-space-9) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.cc-call-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.cc-dot {
  flex-shrink: 0;
}
.cc-dot--done {
  color: var(--color-success);
}
.cc-dot--running {
  color: var(--mk-text-faint);
}
.cc-tname {
  color: var(--mk-text);
  font-weight: 600;
}
.cc-preview {
  color: var(--mk-text-faint);
  word-break: break-all;
  min-width: 0;
}

/* Dim output line under a call, hanging off the ⎿ corner glyph */
.cc-out {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-74);
}
.cc-corner {
  flex-shrink: 0;
}
.cc-out-text {
  min-width: 0;
}
/* Elision marker line: continuation under the corner glyph's column. */
.cc-out--more {
  padding-left: var(--mk-space-26);
}

/* Diff bands: full-width colored rows, no strikethrough */
.cc-diff {
  margin-top: var(--mk-space-6);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}
.cc-dl {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-10);
  padding-left: var(--mk-space-16);
  white-space: pre-wrap;
  font-size: var(--mk-fs-74);
  line-height: 1.7;
}
.cc-dl--del {
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
  color: var(--mk-del-text);
}
.cc-dl--add {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
  color: var(--mk-ins-text);
}
.cc-gut {
  flex-shrink: 0;
  user-select: none;
}
.cc-code {
  min-width: 0;
}

/* Status-bar strip segments (inside the shared .mk-term-hint) */
.cc-diamond {
  color: var(--mk-accent);
  font-size: var(--mk-fs-70);
}
.cc-status {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--mk-text);
}
.cc-seg {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
}
.cc-bindings {
  margin-left: auto;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
}

/* Let the bindings wrap under the segments on narrow screens. */
@media (max-width: 560px) {
  .cc-bindings {
    margin-left: 0;
    flex-basis: 100%;
  }
}
</style>
