<script setup>
// Terminal card for custom-agents.md Step 4 — verifying and smoke-testing a
// new custom agent from a terminal instead of the reload-window → check the
// dropdown round-trip. Beat 1: `texra agents show <name>` printing the real
// detail lines `name:` / `category:` / `source:` / `path:`
// (packages/cli/src/runtime/agents.ts formatCliAgentDetails; `source: custom`
// is the AGENT_SOURCE.CUSTOM literal from src/shared/schemas/agent.ts).
// Beat 2: a one-shot `texra run` against the new agent, ending with the
// printed run-storage path. The agent name matches the page's own example
// filename (literature_review_generator.yaml).
//
// Built on <TermWindow>; .mockup-scoped and token-only. Static strings.
const details = [
  { key: 'name', value: 'literature_review_generator' },
  { key: 'category', value: 'workflow' },
  { key: 'source', value: 'custom' },
  { key: 'path', value: '…/custom_agents/literature_review_generator.yaml' },
];
</script>

<template>
  <TermWindow
    title="texra agents show"
    aria-label="Verify and smoke-test a custom agent from the terminal"
  >
    <!-- Beat 1: the agent is registered, with its source and path -->
    <div class="mk-term-prompt">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra agents show literature_review_generator</span
      >
    </div>
    <dl class="cas-details">
      <div v-for="d in details" :key="d.key" class="cas-line">
        <dt class="cas-key">{{ d.key }}:</dt>
        <dd class="cas-value" :class="{ 'cas-value--hot': d.key === 'source' }">
          {{ d.value }}
        </dd>
      </div>
    </dl>

    <!-- Beat 2: smoke-test it on a real file -->
    <div class="mk-term-prompt cas-run">
      <span class="mk-term-sigil">$</span>
      <span class="mk-term-cmd"
        >texra run literature_review_generator
        <span class="mk-term-flag">--input</span> notes.tex
        <span class="mk-term-flag">--instruction</span> "Draft the related-work
        section."</span
      >
    </div>
    <div class="cas-out">executions/e2c70a94b18f/r0/notes.tex</div>
  </TermWindow>
</template>

<style scoped>
/* Card shell, body, and prompt come from TermWindow + the shared .mk-term-*
   classes in theme/mockup.css. */
.cas-details {
  margin: var(--mk-space-7) 0 0;
  padding-left: var(--mk-space-16);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  font-size: var(--mk-fs-74);
}
.cas-line {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-7);
}
.cas-key {
  color: var(--mk-syn-keyword);
  flex-shrink: 0;
  font-weight: 400;
}
.cas-value {
  margin: 0;
  color: var(--mk-text);
  min-width: 0;
  word-break: break-all;
}
.cas-value--hot {
  color: var(--mk-accent);
  font-weight: 600;
}

.cas-run {
  margin-top: var(--mk-space-10);
  flex-wrap: wrap;
}
.cas-out {
  margin-top: var(--mk-space-5);
  color: var(--color-text-link);
  font-size: var(--mk-fs-72);
  word-break: break-all;
}
</style>
