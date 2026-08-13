<script setup>
// Terminal card for guide/remote-agents.md "3. Use Remote Agents" — the full
// remote loop from a terminal: sign in once, the remote definition resolves by
// name, then it runs like any local agent. `texra login` confirms with the
// real `Signed in as <label>.` line (packages/cli/src/commands/auth.ts);
// `texra agents show` prints the detail lines from formatCliAgentDetails with
// `source: remote` (the AGENT_SOURCE.REMOTE literal in
// src/shared/schemas/agent.ts) marking the cloud-delivered definition.
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
</script>

<template>
  <TermWindow
    title="texra login"
    aria-label="Sign in once and use remote agents by name from the terminal"
  >
    <!-- Beat 1: sign in -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra login</span>
    </div>
    <div class="crm-block">
      <div class="crm-dim">
        Pick a provider: GitHub / Google → browser opens
      </div>
      <div class="crm-ok">Signed in as ada@lab.edu.</div>
    </div>

    <!-- Beat 2: the remote agent resolves by name -->
    <div class="mk-term-prompt crm-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd">texra agents show search</span>
    </div>
    <div class="crm-block">
      <div><span class="crm-k">name:</span> search</div>
      <div><span class="crm-k">category:</span> toolUse</div>
      <div>
        <span class="crm-k">source:</span>
        <span class="crm-hot"> remote</span>
      </div>
    </div>

    <!-- Beat 3: run it like any local agent -->
    <div class="mk-term-prompt crm-beat">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra chat <span class="mk-term-flag">--agent</span> search</span
      >
    </div>
    <div class="crm-note">
      runs like any local agent — same chat, same run history
    </div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.crm-block {
  margin-top: var(--mk-space-4);
  padding-left: var(--mk-space-16);
  font-size: var(--mk-fs-72);
  color: var(--mk-text-dim);
}
.crm-beat {
  margin-top: var(--mk-space-9);
}
.crm-dim {
  color: var(--mk-text-faint);
}
.crm-ok {
  color: var(--color-success);
  font-weight: 600;
}
.crm-k {
  color: var(--mk-syn-keyword);
}
.crm-hot {
  color: var(--mk-accent);
  font-weight: 600;
}
.crm-note {
  padding-left: var(--mk-space-16);
  color: var(--mk-text-faint);
  font-size: var(--mk-fs-70);
  font-style: italic;
}
</style>
