<script setup>
// Frameless side-by-side comparison for the workflow-vs-toolUse binary that the
// page's opening "When to use workflow mode" tip narrates in prose. The two
// modes are the `settings.agentCategory` values, and the first decision a user
// makes. This card contrasts them attribute-by-attribute (Best for / Output /
// Latency / Reflection / Examples) so the reader can compare the modes at a
// glance instead of re-reading the paragraph.
//
// Frameless and .mockup-scoped, so it inherits the shared --mk-* colour +
// dimensional tokens and flips cleanly between the docs light / dark themes.
// Composes StatusPill for the example-agent rosters — no bespoke pill CSS.
import StatusPill from './StatusPill.vue';

const rows = [
  {
    label: 'Best for',
    workflow:
      'Deep single-shot work: rewriting a section, deriving equations, paper → slides.',
    tooluse:
      'Quick edits and read-only questions you iterate on conversationally.',
  },
  {
    label: 'Output',
    workflow:
      'XML-wrapped <document> + <scratchpad> reasoning, saved as versioned files.',
    tooluse: 'Streamed chat replies interleaved with tool calls.',
  },
  {
    label: 'Latency',
    workflow: '10–30 min with frontier reasoning models.',
    tooluse: 'Seconds — replies stream back as they generate.',
  },
  {
    label: 'Reflection',
    workflow: 'Automatic critique rounds (Round 1+).',
    tooluse: 'None — you steer it turn by turn.',
  },
];

const workflowAgents = ['polish', 'correct', 'paper2slide'];
const tooluseAgents = ['chat', 'research', 'review'];
</script>

<template>
  <div class="mockup amc" role="group" aria-label="Workflow vs tool-use agents">
    <!-- workflow column -->
    <section class="amc-col">
      <header class="amc-head amc-head--workflow">
        <wa-icon
          class="amc-ic"
          library="texra"
          name="diagram-project"
        ></wa-icon>
        <span class="amc-cat">workflow</span>
      </header>
      <dl class="amc-rows">
        <template v-for="r in rows" :key="r.label">
          <dt class="amc-key">{{ r.label }}</dt>
          <dd class="amc-val">{{ r.workflow }}</dd>
        </template>
        <dt class="amc-key">Examples</dt>
        <dd class="amc-val amc-pills">
          <StatusPill v-for="a in workflowAgents" :key="a" variant="accent">{{
            a
          }}</StatusPill>
        </dd>
      </dl>
    </section>

    <!-- tool-use column -->
    <section class="amc-col">
      <header class="amc-head amc-head--tooluse">
        <wa-icon
          class="amc-ic"
          library="texra"
          name="screwdriver-wrench"
        ></wa-icon>
        <span class="amc-cat">toolUse</span>
      </header>
      <dl class="amc-rows">
        <template v-for="r in rows" :key="r.label">
          <dt class="amc-key">{{ r.label }}</dt>
          <dd class="amc-val">{{ r.tooluse }}</dd>
        </template>
        <dt class="amc-key">Examples</dt>
        <dd class="amc-val amc-pills">
          <StatusPill v-for="a in tooluseAgents" :key="a" variant="info">{{
            a
          }}</StatusPill>
        </dd>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.amc {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.amc-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.amc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-7);
  border-bottom: 1px solid var(--mk-border);
}
.amc-ic {
  font-size: var(--mk-space-14);
}
.amc-head--workflow .amc-ic {
  color: var(--mk-accent);
}
.amc-head--tooluse .amc-ic {
  color: var(--mk-syn-fn);
}
.amc-cat {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-85);
  font-weight: 700;
  color: var(--mk-text);
}

.amc-rows {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.amc-key {
  font-size: var(--mk-fs-70);
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}
.amc-val {
  margin: var(--mk-space-2) 0 0;
  font-size: var(--mk-fs-78);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.amc-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
}

/* Stack the two columns on a narrow prose column. */
@media (max-width: 560px) {
  .amc {
    grid-template-columns: 1fr;
  }
}
</style>
