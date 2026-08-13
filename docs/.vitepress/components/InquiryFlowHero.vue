<script setup>
// Frameless figure for the `inquiry` tool's copy-out / paste-back flow
// (guide/research-tools.md → External Inquiry). The agent prepares a question,
// you copy it into an external chat subscription (ChatGPT / Claude / Gemini),
// then paste the answer back and the run resumes. Dispatch is non-blocking.
//
// Standalone card (no MockupFrame / dash-nav), in the spirit of
// MemoryCommandsHero — just the focused inquiry modal as it appears in both
// the webview and the CLI terminal modal. Root carries `.mockup` so the shared
// --mk-* tokens resolve and the card flips with the docs light / dark theme.

const targets = [
  { name: 'ChatGPT', icon: 'comment' },
  { name: 'Claude', icon: 'sparkle' },
  { name: 'Gemini', icon: 'robot' },
];
</script>

<template>
  <div
    class="mockup mk-card inq"
    role="group"
    aria-label="external inquiry flow"
  >
    <div class="inq-head">
      <wa-icon
        class="inq-head-ic"
        library="texra"
        name="comment-discussion"
      ></wa-icon>
      <span class="inq-head-name">External Inquiry</span>
      <span class="inq-badge">
        <wa-icon library="texra" name="shield"></wa-icon>
        No API key
      </span>
    </div>

    <!-- Block 1: question prepared by the agent, copied out to a chat -->
    <div class="inq-block">
      <div class="inq-label">
        <wa-icon library="texra" name="cloud-download"></wa-icon>
        Question for external chat
        <code class="inq-tag inq-tag--out">copy out</code>
      </div>
      <div class="inq-prompt inq-prompt--ro">
        Does the spectral-gap bound in Lemma 3 still hold when the operator is
        only essentially self-adjoint? Cite a standard reference.
      </div>
      <div class="inq-row">
        <button class="inq-btn inq-btn--ghost" type="button">
          <wa-icon library="texra" name="link"></wa-icon>
          Copy
        </button>
        <span class="inq-targets">
          <span v-for="t in targets" :key="t.name" class="inq-chip">
            <wa-icon library="texra" :name="t.icon"></wa-icon>
            {{ t.name }}
          </span>
        </span>
      </div>
    </div>

    <!-- Block 2: answer pasted back, resumes the run -->
    <div class="inq-block">
      <div class="inq-label">
        <wa-icon library="texra" name="comment-discussion"></wa-icon>
        Paste the answer
        <code class="inq-tag inq-tag--in">paste back</code>
      </div>
      <div class="inq-prompt inq-prompt--empty">
        Paste the chat's reply here…<span class="inq-caret"></span>
      </div>
      <div class="inq-row inq-row--end">
        <button class="inq-btn inq-btn--brand" type="button">
          <wa-icon library="texra" name="sparkle"></wa-icon>
          Resume run
        </button>
      </div>
    </div>

    <div class="inq-foot">
      <span class="inq-dot"></span>
      Dispatch is non-blocking — the agent's cycle continues while you fetch the
      answer, and resumes automatically once you paste it back.
    </div>
  </div>
</template>

<style scoped>
/* Card shell from shared `.mk-card`; here we stack the body as a flex column
   and use a wider top/bottom margin than the shared default. */
.inq {
  margin: var(--mk-space-16) 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
}

.inq-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
}
.inq-head-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.inq-head-name {
  font-size: var(--mk-fs-84);
  font-weight: 700;
  color: var(--mk-text);
}
.inq-badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-70);
  font-weight: 600;
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 13%, transparent);
  border-radius: var(--mk-radius-pill);
  padding: var(--mk-space-2) var(--mk-space-8);
}

.inq-block {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.inq-label {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  font-size: var(--mk-fs-74);
  font-weight: 600;
  color: var(--color-text-secondary);
}
.inq-label wa-icon {
  font-size: var(--mk-fs-82);
  color: var(--mk-text-faint);
}
.inq-tag {
  margin-left: auto;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-68);
  border-radius: var(--mk-radius-sm);
  padding: 0 var(--mk-space-5);
}
.inq-tag--out {
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
}
.inq-tag--in {
  color: var(--mk-syn-fn);
  background: color-mix(in srgb, var(--mk-syn-fn) 12%, transparent);
}

.inq-prompt {
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-8) var(--mk-space-10);
  font-size: var(--mk-fs-78);
  line-height: 1.5;
  color: var(--mk-text);
}
.inq-prompt--empty {
  color: var(--mk-text-faint);
  font-style: italic;
}
.inq-caret {
  display: inline-block;
  width: 1px;
  height: 1em;
  margin-left: 1px;
  background: var(--mk-accent);
  vertical-align: text-bottom;
  animation: mk-blink 1.1s step-end infinite;
}

.inq-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.inq-row--end {
  justify-content: flex-end;
}
.inq-targets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
}
.inq-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-70);
  font-family: var(--vp-font-family-mono);
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-pill, 999px);
  padding: var(--mk-space-2) var(--mk-space-8);
}
.inq-chip wa-icon {
  font-size: var(--mk-fs-78);
  color: var(--mk-text-faint);
}

.inq-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-5) var(--mk-space-10);
  font-size: var(--mk-fs-76);
  font-weight: 600;
  font-family: var(--vp-font-family-base);
  cursor: default;
}
.inq-btn wa-icon {
  font-size: var(--mk-fs-82);
}
.inq-btn--ghost {
  color: var(--color-text-secondary);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
}
.inq-btn--brand {
  color: var(--wa-color-brand-on-loud);
  background: var(--mk-accent);
  border: 1px solid var(--mk-accent);
}

.inq-foot {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  padding-top: var(--mk-space-8);
  border-top: 1px solid var(--mk-border);
  font-size: var(--mk-fs-72);
  line-height: 1.5;
  color: var(--mk-text-faint);
}
.inq-dot {
  position: relative;
  top: var(--mk-space-2);
  flex-shrink: 0;
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  background: var(--mk-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--mk-accent) 60%, transparent);
  animation: mk-shpulse 1.8s infinite;
}

@media (max-width: 560px) {
  .inq-row {
    flex-wrap: wrap;
  }
}
</style>
