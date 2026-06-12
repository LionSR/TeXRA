<script setup>
// Terminal-output card for `texra tools list`. The real command prints six
// tab-separated columns — ID NAME CATEGORY ENABLED DETECTED NOTE, booleans as
// yes / no / - and NOTE carrying the registered install command when a tool is
// not detected (packages/cli/src/runtime/tools.ts formatCliToolList /
// noteForTool). This renders that table so the columns and the
// enabled-vs-detected distinction are concrete at a glance.
//
// Built on the <TermWindow> primitive; the shared --mk-* tokens resolve here
// and the card flips with the docs light / dark theme. Ids, names, categories,
// and notes match src/tools/externalToolDefs.ts + noteForTool (statusLabel ??
// authNote ?? configNotes ?? installCommand): the undetected claude-agent row
// shows its install command, codex shows its authNote, wolfram/lean4 their
// configNotes. ENABLED prints '-' for non-toggleable tools (wolfram, lean4),
// exactly as formatCliBoolean does.
const rows = [
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'ai-agents',
    enabled: 'yes',
    detected: 'yes',
    note: 'Uses ChatGPT subscription (free with Plus/Pro)',
  },
  {
    id: 'claude-agent',
    name: 'Claude Code CLI',
    category: 'ai-agents',
    enabled: 'yes',
    detected: 'no',
    note: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'zotero',
    name: 'Zotero Integration',
    category: 'ai-agents',
    enabled: 'no',
    detected: 'yes',
    note: 'Zotero must be running with Better BibTeX installed. Port configurable via texra.bib.zoteroPort.',
  },
  {
    id: 'wolfram',
    name: 'Wolfram Language',
    category: 'computation',
    enabled: '-',
    detected: 'no',
    note: 'Requires the free Wolfram Engine (provides wolframscript).',
  },
  {
    id: 'lean4',
    name: 'Lean 4 Proof Assistant',
    category: 'lean',
    enabled: '-',
    detected: 'yes',
    note: 'VS Code build: requires the leanprover.lean4 extension. CLI / desktop builds: requires `lake` on PATH; each Lake project root gets its own language server, surfaced below.',
  },
];
</script>

<template>
  <TermWindow title="texra tools list" aria-label="texra tools list output">
    <div class="ctl-scroll">
      <!-- Prompt line -->
      <div class="mk-term-prompt ctl-prompt">
        <span class="mk-term-sigil">$</span>
        <span class="mk-term-cmd">texra tools list</span>
      </div>

      <!-- Column header -->
      <div class="ctl-row ctl-row--head">
        <span class="ctl-c ctl-c--id">ID</span>
        <span class="ctl-c ctl-c--name">NAME</span>
        <span class="ctl-c ctl-c--cat">CATEGORY</span>
        <span class="ctl-c ctl-c--enabled">ENABLED</span>
        <span class="ctl-c ctl-c--detected">DETECTED</span>
        <span class="ctl-c ctl-c--note">NOTE</span>
      </div>

      <!-- Integration rows -->
      <div v-for="r in rows" :key="r.id" class="ctl-row">
        <span class="ctl-c ctl-c--id">{{ r.id }}</span>
        <span class="ctl-c ctl-c--name">{{ r.name }}</span>
        <span class="ctl-c ctl-c--cat">{{ r.category }}</span>
        <span class="ctl-c ctl-c--enabled">
          <span
            v-if="r.enabled !== '-'"
            class="ctl-dot"
            :class="r.enabled === 'yes' ? 'ctl-dot--on' : 'ctl-dot--off'"
          ></span>
          {{ r.enabled }}
        </span>
        <span
          class="ctl-c ctl-c--detected"
          :class="r.detected === 'yes' ? 'ctl-det--yes' : 'ctl-det--no'"
        >
          <wa-icon
            library="texra"
            :name="r.detected === 'yes' ? 'check' : 'close'"
          ></wa-icon>
          {{ r.detected }}
        </span>
        <span class="ctl-c ctl-c--note">{{ r.note }}</span>
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, titlebar, and body come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. The table is denser than prose terminal cards,
   so it tightens the body font a step and scrolls horizontally on narrow
   columns rather than reflowing — terminal output is intrinsically
   column-aligned. */
.ctl-scroll {
  overflow-x: auto;
  font-size: var(--mk-fs-76);
}
.ctl-prompt {
  margin-bottom: var(--mk-space-8);
}

/* Table rows: a fixed grid so columns align like fixed-width terminal output.
   The tokenized floor keeps columns readable; .ctl-scroll provides the
   horizontal scroll instead of reflowing. */
.ctl-row {
  display: grid;
  grid-template-columns: 0.8fr 1.3fr 0.8fr 0.55fr 0.6fr 1.4fr;
  min-width: var(--mk-size-520);
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
.ctl-c--note {
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-72);
}
</style>
