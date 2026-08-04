<script setup>
// Terminal card for guide/agent-integrations.md "Quick Start" — the
// IntegrationCard flow (Not Found → Install → Sign in → Re-check → Available)
// beat for beat, from a terminal. Output lines reproduce the real shapes:
// `texra tools status codex` prints `key: value` detail lines including the
// registered installCommand / authCommand (packages/cli/src/runtime/tools.ts
// formatCliToolStatus); `tools install --run` prints the install guide then
// executes the registered command; `tools auth` runs `codex login`. The codex
// id, commands, and guide text match src/tools/externalToolDefs.ts verbatim.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
</script>

<template>
  <TermWindow
    title="texra tools"
    aria-label="Detect, install, authenticate, and recheck an integration from the terminal"
  >
    <!-- Beat 1: detect -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra tools status codex</span>
    </div>
    <div class="ctf-block">
      <div><span class="ctf-k">name:</span> OpenAI Codex CLI</div>
      <div>
        <span class="ctf-k">detected:</span>
        <span class="ctf-no"> no</span>
      </div>
      <div>
        <span class="ctf-k">installCommand:</span> npm install -g @openai/codex
      </div>
      <div><span class="ctf-k">authCommand:</span> codex login</div>
    </div>

    <!-- Beat 2: install -->
    <div class="mk-term-prompt ctf-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra tools install codex <span class="mk-term-flag">--run</span></span
      >
    </div>
    <div class="ctf-block ctf-dim">
      <div>Install the Codex CLI (choose one):</div>
      <div class="ctf-indent">npm install -g @openai/codex</div>
    </div>

    <!-- Beat 3: sign in -->
    <div class="mk-term-prompt ctf-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra tools auth codex</span>
    </div>
    <div class="ctf-block ctf-dim">
      <div>Uses ChatGPT subscription (free with Plus/Pro)</div>
      <div>Command: codex login</div>
    </div>

    <!-- Beat 4: re-check -->
    <div class="mk-term-prompt ctf-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra tools status codex</span>
    </div>
    <div class="ctf-block">
      <div>
        <span class="ctf-k">detected:</span>
        <span class="ctf-yes"> yes</span>
      </div>
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.ctf-block {
  margin-top: var(--mk-space-4);
  padding-left: var(--mk-space-16);
  font-size: var(--mk-fs-72);
  color: var(--mk-text-dim);
}
.ctf-beat {
  margin-top: var(--mk-space-9);
}
.ctf-k {
  color: var(--mk-syn-keyword);
}
.ctf-no {
  color: var(--color-warning);
  font-weight: 600;
}
.ctf-yes {
  color: var(--color-success);
  font-weight: 600;
}
.ctf-dim {
  color: var(--mk-text-faint);
}
.ctf-indent {
  padding-left: var(--mk-space-12);
}
</style>
