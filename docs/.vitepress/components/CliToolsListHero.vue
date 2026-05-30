<script setup>
// Frameless terminal-output card for `texra tools list`. The Tools and
// Integrations section of guide/texra-cli.md describes the command as reporting
// "each integration id, name, category, enabled state, and detection result" —
// five structured columns the reader currently has to imagine. This renders that
// tabular output so the columns, the enabled-vs-disabled state (status dot), and
// the detected-vs-not state (check / x glyph) are concrete at a glance.
//
// Standalone (no MockupFrame) — a terminal card on the .mockup surface, mirroring
// CliChatHero's titlebar + mono body, so the shared --mk-* tokens resolve here
// and the whole thing flips with the docs light / dark theme. Integration ids,
// names, and categories match resources/externalToolDefs verbatim; the
// enabled/detection mix is a believable static snapshot showing both states.
const rows = [
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'ai-agents',
    enabled: true,
    detected: true,
  },
  {
    id: 'claude-agent',
    name: 'Claude Code CLI',
    category: 'ai-agents',
    enabled: true,
    detected: true,
  },
  {
    id: 'wolfram',
    name: 'Wolfram Language',
    category: 'computation',
    enabled: true,
    detected: false,
  },
  {
    id: 'lean4',
    name: 'Lean 4',
    category: 'lean',
    enabled: false,
    detected: true,
  },
  {
    id: 'texcount',
    name: 'TeXcount',
    category: 'latex',
    enabled: true,
    detected: true,
  },
];
</script>

<template>
  <div class="mockup ctl" role="group" aria-label="texra tools list output">
    <!-- Faux terminal titlebar -->
    <div class="ctl-bar">
      <span class="ctl-light ctl-light--r"></span>
      <span class="ctl-light ctl-light--y"></span>
      <span class="ctl-light ctl-light--g"></span>
      <span class="ctl-title">texra tools list</span>
    </div>

    <div class="ctl-body">
      <!-- Prompt line -->
      <div class="ctl-prompt">
        <span class="ctl-sigil">$</span>
        <span class="ctl-cmd">texra tools list</span>
      </div>

      <!-- Column header -->
      <div class="ctl-row ctl-row--head">
        <span class="ctl-c ctl-c--id">ID</span>
        <span class="ctl-c ctl-c--name">NAME</span>
        <span class="ctl-c ctl-c--cat">CATEGORY</span>
        <span class="ctl-c ctl-c--enabled">ENABLED</span>
        <span class="ctl-c ctl-c--detected">DETECTED</span>
      </div>

      <!-- Integration rows -->
      <div v-for="r in rows" :key="r.id" class="ctl-row">
        <span class="ctl-c ctl-c--id">{{ r.id }}</span>
        <span class="ctl-c ctl-c--name">{{ r.name }}</span>
        <span class="ctl-c ctl-c--cat">{{ r.category }}</span>
        <span class="ctl-c ctl-c--enabled">
          <span
            class="ctl-dot"
            :class="r.enabled ? 'ctl-dot--on' : 'ctl-dot--off'"
          ></span>
          {{ r.enabled ? 'enabled' : 'disabled' }}
        </span>
        <span
          class="ctl-c ctl-c--detected"
          :class="r.detected ? 'ctl-det--yes' : 'ctl-det--no'"
        >
          <wa-icon
            library="texra"
            :name="r.detected ? 'check' : 'close'"
          ></wa-icon>
          {{ r.detected ? 'detected' : 'not found' }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctl {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-12) 0;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

/* Titlebar (mirrors CliChatHero) */
.ctl-bar {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-7) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border);
}
.ctl-light {
  width: var(--mk-space-9);
  height: var(--mk-space-9);
  border-radius: 50%;
  flex-shrink: 0;
}
.ctl-light--r {
  background: var(--color-error);
}
.ctl-light--y {
  background: var(--color-warning);
}
.ctl-light--g {
  background: var(--color-success);
}
.ctl-title {
  margin-left: var(--mk-space-7);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
}

/* Body */
.ctl-body {
  padding: var(--mk-space-12) var(--mk-space-14);
  background: var(--mk-bg-deep);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-76);
  line-height: 1.6;
  color: var(--wa-color-text-normal);
  overflow-x: auto;
}
.ctl-prompt {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
  margin-bottom: var(--mk-space-8);
}
.ctl-sigil {
  color: var(--mk-syn-fn);
  font-weight: 600;
}
.ctl-cmd {
  color: var(--mk-text);
}

/* Table rows: a fixed grid so columns align like fixed-width terminal output. */
.ctl-row {
  display: grid;
  grid-template-columns:
    minmax(96px, 0.9fr)
    minmax(120px, 1.4fr)
    minmax(80px, 0.9fr)
    minmax(86px, 0.8fr)
    minmax(92px, 0.8fr);
  gap: var(--mk-space-8);
  align-items: center;
  padding: var(--mk-space-3) 0;
}
.ctl-row--head {
  border-bottom: 1px solid var(--mk-border);
  margin-bottom: var(--mk-space-3);
  padding-bottom: var(--mk-space-5);
}
.ctl-row--head .ctl-c {
  font-size: var(--mk-fs-66);
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--color-text-tertiary);
}
.ctl-c {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctl-c--id {
  color: var(--mk-syn-fn);
  font-weight: 600;
}
.ctl-c--name {
  color: var(--mk-text);
}
.ctl-c--cat {
  color: var(--mk-syn-keyword);
}
.ctl-c--enabled,
.ctl-c--detected {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
}
.ctl-dot {
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  flex-shrink: 0;
}
.ctl-dot--on {
  background: var(--color-success);
}
.ctl-dot--off {
  background: var(--color-text-tertiary);
}
.ctl-det--yes {
  color: var(--color-success);
}
.ctl-det--no {
  color: var(--mk-text-faint);
}
.ctl-c--detected wa-icon {
  font-size: var(--mk-space-11);
}

/* On a narrow column, the body scrolls horizontally (overflow-x:auto) rather
   than reflowing — terminal output is intrinsically column-aligned. */
@media (max-width: 560px) {
  .ctl-row {
    grid-template-columns:
      minmax(88px, 0.9fr)
      minmax(110px, 1.3fr)
      minmax(74px, 0.8fr)
      minmax(82px, 0.8fr)
      minmax(86px, 0.8fr);
    min-width: 460px;
  }
}
</style>
