<script setup>
// Dashboard → Integrations cards (mirrors the OpenAI Codex CLI / Claude Code
// CLI setup cards). Two states stacked: a `Not Found` card whose setup actions
// are expanded (Install in Terminal · Sign in), and an `Available`
// card with its version + settings summary. The contrast visualizes the
// Re-check flip the Quick Start prose describes.
//
// Root carries `.mockup` so the shared `--mk-*` tokens resolve and the card
// flips with the docs light / dark theme. Static strings only.
import StatusPill from './StatusPill.vue';
</script>

<template>
  <div
    class="mockup integ-cards"
    role="group"
    aria-label="integration setup cards"
  >
    <!-- Not Found: setup actions expanded -->
    <article class="ic-card">
      <header class="ic-head">
        <wa-icon class="ic-glyph" library="texra" name="robot"></wa-icon>
        <span class="ic-title">OpenAI Codex CLI</span>
        <StatusPill variant="neutral" icon="circle-xmark" shape="pill"
          >Not Found</StatusPill
        >
      </header>
      <p class="ic-sub">CLI binary not detected on PATH.</p>
      <div class="ic-acts">
        <button type="button" class="r-btn">
          <wa-icon library="texra" name="terminal"></wa-icon>Install in Terminal
        </button>
        <button type="button" class="r-btn">
          <wa-icon library="texra" name="right-to-bracket"></wa-icon>Sign in
        </button>
      </div>
    </article>

    <div class="ic-flip" aria-hidden="true">
      <wa-icon library="texra" name="arrow-down"></wa-icon>
      <span>Re-check</span>
    </div>

    <!-- Available: version + settings summary -->
    <article class="ic-card ic-card--ok">
      <header class="ic-head">
        <wa-icon
          class="ic-glyph ic-glyph--ok"
          library="texra"
          name="robot"
        ></wa-icon>
        <span class="ic-title">Claude Code CLI</span>
        <StatusPill variant="success" icon="circle-check" shape="pill"
          >Available</StatusPill
        >
      </header>
      <p class="ic-sub">
        <code>claude 1.x</code> detected in the extension host environment.
      </p>
      <dl class="ic-summary">
        <div class="ic-srow">
          <dt>Model</dt>
          <dd>
            <StatusPill variant="accent" shape="chip">Sonnet 5</StatusPill>
          </dd>
        </div>
        <div class="ic-srow">
          <dt>Permission mode</dt>
          <dd>
            <StatusPill variant="info" shape="pill"
              >Auto-accept edits</StatusPill
            >
          </dd>
        </div>
        <div class="ic-srow">
          <dt>Reasoning effort</dt>
          <dd><StatusPill variant="info" shape="pill">High</StatusPill></dd>
        </div>
      </dl>
    </article>
  </div>
</template>

<style scoped>
/* Standalone cards. Tokens + `.r-btn` mirror MemoryHero; status pills shared. */
.integ-cards {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}

.ic-card {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.ic-card--ok {
  border-color: var(--color-success);
}

.ic-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.ic-glyph {
  font-size: var(--mk-space-16);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.ic-glyph--ok {
  color: var(--mk-accent);
}
.ic-title {
  font-size: var(--mk-fs-84);
  font-weight: 600;
  color: var(--mk-text);
  margin-right: auto;
}
.ic-sub {
  margin: var(--mk-space-6) 0 0;
  font-size: var(--mk-fs-74);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.ic-sub code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--color-text-link);
}

.ic-acts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-8);
  margin-top: var(--mk-space-10);
}
.r-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-72);
  color: var(--wa-color-text-normal);
  background: var(--mk-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-5) var(--mk-space-10);
  cursor: pointer;
}
.r-btn:hover {
  background: var(--mk-border-soft);
}
.r-btn wa-icon {
  font-size: var(--mk-space-12);
  color: var(--color-text-secondary);
}
.r-btn--accent {
  border-color: var(--mk-accent);
  color: var(--mk-text);
}
.r-btn--accent wa-icon {
  color: var(--mk-accent);
}

/* The Re-check flip connector between the two states. */
.ic-flip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-66);
  color: var(--color-text-tertiary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ic-flip wa-icon {
  font-size: var(--mk-space-13);
}

.ic-summary {
  margin: var(--mk-space-10) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-5);
}
.ic-srow {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.ic-srow dt {
  flex: 0 0 var(--mk-size-120, 120px);
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
}
.ic-srow dd {
  margin: 0;
}

@media (max-width: 560px) {
  .ic-srow {
    flex-wrap: wrap;
  }
  .ic-srow dt {
    flex-basis: 100%;
  }
}
</style>
