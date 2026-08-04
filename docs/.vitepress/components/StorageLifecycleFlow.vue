<script setup>
// The output lifecycle for guide/file-management.md → "Task Run Storage".
// Workflow outputs are written FIRST into an isolated task-run storage folder
// (executions/<id>/, r{round}/output.ext) — never directly over the workspace.
// From there three commands move the artifacts to three different places:
//   Accept → copies reviewed outputs back into the workspace
//   Pack   → archives the whole run into the History folder
//   Clean  → deletes the run folder
// The prose scatters these across three sections (Pack / Clean / Task Run
// Storage); this single flow puts the task-storage box at the center with one
// labeled branch per command so the three-location mental model is visible.
//
// Root carries `.mockup`, so the shared `--mk-*` tokens and the
// .surface/.cl/.kw mono-code vocabulary from theme/mockup.css resolve here and
// flip with the docs light / dark theme. Static strings only — mirrors the
// MergeFlowHero frameless-flow pattern (central node, arrows, mobile stacking).
import StatusPill from './StatusPill.vue';
</script>

<template>
  <div
    class="mockup store-flow"
    role="group"
    aria-label="task-run storage lifecycle: Accept, Pack, Clean"
  >
    <!-- The center of gravity: the isolated task-run storage folder -->
    <article class="sf-store">
      <header class="sf-store-head">
        <wa-icon
          class="sf-store-ic"
          library="texra"
          name="folder-open"
        ></wa-icon>
        <span class="sf-store-title">Task-run storage</span>
        <StatusPill variant="info" shape="chip">isolated</StatusPill>
      </header>
      <div class="surface sf-code">
        <div class="cl"><span class="kw">executions/</span>&lt;id&gt;/</div>
        <div class="cl indent">r0/output.tex</div>
        <div class="cl indent">r0/output.log</div>
        <div class="cl indent">r1/output.tex</div>
      </div>
      <footer class="sf-store-foot">
        written here first — never over your workspace
      </footer>
    </article>

    <!-- Three labeled branches, one per command -->
    <div class="sf-branches">
      <div class="sf-branch">
        <span class="sf-cmd sf-cmd-ok">
          <wa-icon library="texra" name="check"></wa-icon> Accept
        </span>
        <wa-icon class="sf-arr" library="texra" name="arrow-right"></wa-icon>
        <span class="sf-dest">
          <wa-icon class="sf-dest-ic" library="texra" name="folder"></wa-icon>
          <span class="sf-dest-txt">
            <span class="sf-dest-name">Workspace</span>
            <span class="sf-dest-sub">copies reviewed outputs back in</span>
          </span>
        </span>
      </div>

      <div class="sf-branch">
        <span class="sf-cmd">
          <wa-icon library="texra" name="box-archive"></wa-icon> Pack
        </span>
        <wa-icon class="sf-arr" library="texra" name="arrow-right"></wa-icon>
        <span class="sf-dest">
          <wa-icon
            class="sf-dest-ic"
            library="texra"
            name="clock-rotate-left"
          ></wa-icon>
          <span class="sf-dest-txt">
            <span class="sf-dest-name">History/</span>
            <span class="sf-dest-sub">archives the whole run, timestamped</span>
          </span>
        </span>
      </div>

      <div class="sf-branch">
        <span class="sf-cmd sf-cmd-del">
          <wa-icon library="texra" name="trash"></wa-icon> Clean
        </span>
        <wa-icon class="sf-arr" library="texra" name="arrow-right"></wa-icon>
        <span class="sf-dest sf-dest-del">
          <wa-icon class="sf-dest-ic" library="texra" name="trash"></wa-icon>
          <span class="sf-dest-txt">
            <span class="sf-dest-name">Deleted</span>
            <span class="sf-dest-sub"
              >removes the run folder; inputs untouched</span
            >
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Standalone flow. Tokens + .surface/.cl/.kw from `.mockup` (theme/mockup.css). */
.store-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-16);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}

/* Central task-storage box. */
.sf-store {
  display: flex;
  flex-direction: column;
  flex: 1 1 var(--mk-size-220);
  min-width: 0;
  background: var(--mk-bg);
  border: 1px solid var(--mk-accent);
  border-radius: var(--mk-radius-lg);
  overflow: hidden;
}
.sf-store-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-6);
  padding: var(--mk-space-7) var(--mk-space-10);
  background: color-mix(in srgb, var(--mk-accent) 10%, transparent);
  border-bottom: 1px solid var(--mk-border);
}
.sf-store-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.sf-store-title {
  font-weight: 600;
  font-size: var(--mk-fs-78);
  color: var(--mk-text);
  margin-right: auto;
}
.sf-code {
  padding: var(--mk-space-8) var(--mk-space-10);
  font-size: var(--mk-fs-70);
  line-height: 1.55;
}
.sf-code .cl {
  font-family: var(--vp-font-family-mono);
  color: var(--color-text-secondary);
}
.sf-code .indent {
  padding-left: var(--mk-space-12);
}
.sf-store-foot {
  padding: var(--mk-space-6) var(--mk-space-10);
  border-top: 1px solid var(--mk-border);
  font-size: var(--mk-fs-66);
  color: var(--color-text-secondary);
}

/* Branch column: three command → destination rows. */
.sf-branches {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  flex: 1 1 var(--mk-size-280);
  min-width: 0;
}
.sf-branch {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}

.sf-cmd {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  flex-shrink: 0;
  font-size: var(--mk-fs-72);
  font-weight: 600;
  color: var(--mk-text);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-4) var(--mk-space-9);
  min-width: var(--mk-size-72);
}
.sf-cmd wa-icon {
  font-size: var(--mk-space-12);
  color: var(--color-text-secondary);
}
.sf-cmd-ok {
  border-color: var(--color-success);
}
.sf-cmd-ok wa-icon {
  color: var(--color-success);
}
.sf-cmd-del wa-icon {
  color: var(--mk-del-text);
}

.sf-arr {
  font-size: var(--mk-space-13);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.sf-dest {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  min-width: 0;
  flex: 1 1 auto;
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-5) var(--mk-space-10);
}
.sf-dest-del {
  border-style: dashed;
  opacity: 0.85;
}
.sf-dest-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.sf-dest-del .sf-dest-ic {
  color: var(--mk-del-text);
}
.sf-dest-txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sf-dest-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  font-weight: 500;
  color: var(--color-text-link);
}
.sf-dest-del .sf-dest-name {
  color: var(--mk-del-text);
}
.sf-dest-sub {
  font-size: var(--mk-fs-66);
  color: var(--color-text-secondary);
}

/* Stack the store above its branches on narrow screens. */
@media (max-width: 720px) {
  .store-flow {
    flex-direction: column;
    align-items: stretch;
    gap: var(--mk-space-12);
  }
  .sf-store,
  .sf-branches {
    flex: none;
  }
}
</style>
