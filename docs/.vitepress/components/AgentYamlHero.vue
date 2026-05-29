<script setup>
// Frameless code-card for an agent definition file (guide/agent-architecture.md
// → "Understanding the YAML Structure"). Shows the shape of an agent `.yaml`:
// a `settings:` block and a `prompts:` block, with a dim annotation pill to the
// right of each key explaining its role. Standalone (no MockupFrame) — just the
// focused code card. Keys use --mk-syn-keyword, template vars are --mk-accent
// chips, values are plain mono text. Mirrors the prose of the YAML-structure
// section (agentCategory / prefills / systemPrompt / userPrefix / userRequest).
//
// The root carries `.mockup` so the shared `--mk-*` colour + dimensional tokens
// resolve here and the card flips cleanly between the docs light / dark themes.
</script>

<template>
  <div
    class="mockup mk-card yaml-hero"
    role="group"
    aria-label="agent YAML structure"
  >
    <div class="mk-card-head">
      <wa-icon
        class="mk-card-head-ic"
        library="texra"
        name="file-code"
      ></wa-icon>
      <span class="mk-card-title">polish.yaml</span>
      <span class="mk-card-sub">agent definition</span>
    </div>

    <div class="yh-body">
      <!-- settings block -->
      <div class="yh-line">
        <code class="yh-code"><span class="kw">settings</span>:</code>
        <span class="yh-note">how to run</span>
      </div>
      <div class="yh-line indent">
        <code class="yh-code"
          ><span class="kw">agentCategory</span>: workflow</code
        >
        <span class="yh-note">workflow vs toolUse</span>
      </div>
      <div class="yh-line indent">
        <code class="yh-code"
          ><span class="kw">prefills</span>:
          <span class="tag">&lt;scratchpad&gt;</span></code
        >
        <span class="yh-note">starts every response</span>
      </div>
      <div class="yh-line indent">
        <code class="yh-code"
          ><span class="kw">documentTag</span>: document</code
        >
        <span class="yh-note">XML output wrapper</span>
      </div>

      <div class="yh-gap"></div>

      <!-- prompts block -->
      <div class="yh-line">
        <code class="yh-code"><span class="kw">prompts</span>:</code>
        <span class="yh-note">what to say to the LLM</span>
      </div>
      <div class="yh-line indent">
        <code class="yh-code"><span class="kw">systemPrompt</span>: |</code>
        <span class="yh-note">the LLM's role</span>
      </div>
      <div class="yh-line indent2">
        <code class="yh-code"
          ><span class="cmt">You are an expert LaTeX editor…</span></code
        >
      </div>
      <div class="yh-line indent">
        <code class="yh-code"><span class="kw">userPrefix</span>: |</code>
        <span class="yh-note">your files + instruction</span>
      </div>
      <div class="yh-line indent2">
        <code class="yh-code"
          ><span class="tag">&#123;&#123; INPUT_CONTENT &#125;&#125;</span> ·
          <span class="tag">&#123;&#123; INSTRUCTION &#125;&#125;</span></code
        >
      </div>
      <div class="yh-line indent">
        <code class="yh-code"><span class="kw">userRequest</span>:</code>
        <span class="yh-note">array → reflection rounds</span>
      </div>
      <div class="yh-line indent2">
        <code class="yh-code"
          >- <span class="cmt">Round 0 — write the revision</span></code
        >
        <span class="yh-note round">round 0</span>
      </div>
      <div class="yh-line indent2">
        <code class="yh-code"
          >- <span class="cmt">Round 1 — critique & improve</span></code
        >
        <span class="yh-note round">reflection</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone card. Shell + inline mono header come from the shared `.mk-card*`
   family (theme/mockup.css); only the body styling is unique below. */
.yh-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}
.yh-line {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-10);
  padding: var(--mk-space-2) var(--mk-space-4);
}
.yh-line.indent {
  padding-left: var(--mk-space-16);
}
.yh-line.indent2 {
  padding-left: var(--mk-space-26);
}
.yh-gap {
  height: var(--mk-space-6);
}

.yh-code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  color: var(--mk-text);
  white-space: pre-wrap;
}
.yh-code .kw {
  color: var(--mk-syn-keyword);
  font-weight: 600;
}
.yh-code .cmt {
  color: var(--mk-syn-comment);
}
.yh-code .tag {
  color: var(--mk-accent);
  background: rgba(200, 155, 224, 0.13);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-4);
}

.yh-note {
  margin-left: auto;
  flex-shrink: 0;
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-2) var(--mk-space-7);
  line-height: 1.4;
}
.yh-note.round {
  color: var(--mk-accent);
  background: rgba(200, 155, 224, 0.1);
  border-color: rgba(200, 155, 224, 0.32);
}

/* Drop the annotation pills below the code on narrow screens. */
@media (max-width: 560px) {
  .yh-note {
    display: none;
  }
}
</style>
