<script setup>
// Frameless figure for the Quick Reference "Type" column: the two execution
// SHAPES behind every built-in agent. Tool-use = a loop (instruction → read ·
// edit · run tool → repeat → done); Workflow = a linear pipeline (input file →
// edit → versioned diff). The agent-picker dropdown above already shows the
// ROSTER; this shows WHY the categories behave differently — why `chat`/
// `research` feel conversational while `polish`/`correct` hand back a diff.
//
// Frameless and .mockup-scoped, so it inherits --mk-* and flips with the docs
// theme. Composes StatusPill for the type badge + step/tool chips — no bespoke
// pill CSS — and reuses the editor-surface diff colours (--mk-ins/del-text).
import StatusPill from './StatusPill.vue';

const loopSteps = ['read', 'edit', 'run tool'];
</script>

<template>
  <div class="mockup ams" role="group" aria-label="Agent execution shapes">
    <!-- Tool-use: a loop -->
    <section class="ams-col">
      <header class="ams-head">
        <wa-icon
          class="ams-ic ams-ic--tooluse"
          library="texra"
          name="screwdriver-wrench"
        ></wa-icon>
        <span class="ams-title">Tool-use</span>
        <StatusPill variant="info" shape="chip">loop</StatusPill>
      </header>

      <div class="ams-shape ams-shape--loop">
        <span class="ams-node ams-node--in">Instruction</span>
        <wa-icon class="ams-arrow" library="texra" name="arrow-right"></wa-icon>
        <div class="ams-cycle">
          <div class="ams-cycle-chips">
            <StatusPill
              v-for="s in loopSteps"
              :key="s"
              variant="info"
              shape="chip"
              >{{ s }}</StatusPill
            >
          </div>
          <span class="ams-repeat">
            <wa-icon library="texra" name="arrow-repeat"></wa-icon>
            repeat
          </span>
        </div>
        <wa-icon class="ams-arrow" library="texra" name="arrow-right"></wa-icon>
        <span class="ams-node ams-node--done">Done</span>
      </div>

      <p class="ams-sub">
        Converse and call tools in a loop until the task is finished.
      </p>
    </section>

    <!-- Workflow: a linear pipeline -->
    <section class="ams-col">
      <header class="ams-head">
        <wa-icon
          class="ams-ic ams-ic--workflow"
          library="texra"
          name="diagram-project"
        ></wa-icon>
        <span class="ams-title">Workflow</span>
        <StatusPill variant="accent" shape="chip">pipeline</StatusPill>
      </header>

      <div class="ams-shape ams-shape--pipe">
        <span class="ams-node">
          <wa-icon
            class="ams-node-ic"
            library="texra"
            name="file-code"
          ></wa-icon>
          Input file
        </span>
        <wa-icon class="ams-arrow" library="texra" name="arrow-right"></wa-icon>
        <span class="ams-node ams-node--edit">Edit</span>
        <wa-icon class="ams-arrow" library="texra" name="arrow-right"></wa-icon>
        <span class="ams-node ams-node--diff">
          <span class="ams-swatch ams-swatch--del"></span>
          <span class="ams-swatch ams-swatch--ins"></span>
          Diff
        </span>
      </div>

      <p class="ams-sub">
        Run a fixed input → edit → diff pipeline; hand back a versioned diff.
      </p>
    </section>
  </div>
</template>

<style scoped>
.ams {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.ams-col {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  min-width: 0;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.ams-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
}
.ams-ic {
  font-size: var(--mk-space-14);
}
.ams-ic--tooluse {
  color: var(--mk-syn-fn);
}
.ams-ic--workflow {
  color: var(--mk-accent);
}
.ams-title {
  font-size: var(--mk-fs-90);
  font-weight: 700;
  color: var(--mk-text);
}

/* Shared shape row: nodes joined by arrows, wraps on narrow widths. */
.ams-shape {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
  padding: var(--mk-space-10) var(--mk-space-2);
}
.ams-node {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-5) var(--mk-space-8);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  font-size: var(--mk-fs-74);
  font-weight: 600;
  color: var(--mk-text);
  white-space: nowrap;
}
.ams-node-ic {
  font-size: var(--mk-space-12);
  color: var(--color-text-link);
}
.ams-node--in,
.ams-node--done {
  color: var(--mk-syn-fn);
}
.ams-node--edit {
  color: var(--mk-accent);
}
.ams-node--diff {
  border-color: var(--mk-ins-text);
}
.ams-swatch {
  display: inline-block;
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 2px;
}
.ams-swatch--del {
  background: var(--mk-del-text);
}
.ams-swatch--ins {
  background: var(--mk-ins-text);
}
.ams-arrow {
  font-size: var(--mk-space-13);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

/* The loop's middle cell: tool-call chips with a circular "repeat" caption. */
.ams-cycle {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--mk-space-4);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-6) var(--mk-space-8);
  border: 1px dashed var(--mk-syn-fn);
  background: color-mix(in srgb, var(--mk-syn-fn) 6%, transparent);
}
.ams-cycle-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--mk-space-4);
}
.ams-repeat {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-68);
  font-weight: 600;
  color: var(--mk-syn-fn);
}
.ams-repeat wa-icon {
  font-size: var(--mk-space-11);
}

.ams-sub {
  margin: 0;
  margin-top: auto;
  padding-top: var(--mk-space-6);
  border-top: 1px solid var(--mk-border);
  font-size: var(--mk-fs-74);
  line-height: 1.45;
  color: var(--color-text-secondary);
}

/* Stack the two columns on a narrow prose column. */
@media (max-width: 560px) {
  .ams {
    grid-template-columns: 1fr;
  }
}
</style>
