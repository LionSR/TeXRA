<script setup>
// Frameless command palette for `lean_project` — the project-wide commands the
// agent runs without a target file (guide/lean.md → "Manage the Project").
// The prose groups them three ways and gates one group to VS Code; a nested
// bullet list buries that gate. Here the groups are labelled rows of command
// pills, with a "VS Code only" tag on the Setup row, so readers scan the
// capability groups and see the platform gate at a glance.
//
// Built from <MockCard> (shared frameless .mk-card shell + inline mono header)
// and reuses the .f-label group-label vocabulary from theme/mockup.css; the
// command pills are local. Root carries `.mockup` (via MockCard) so the shared
// --mk-* tokens resolve and it flips with the docs light / dark theme.
//
// Command names match guide/lean.md exactly.
import MockCard from './MockCard.vue';

const groups = [
  {
    label: 'Server',
    icon: 'sync',
    cmds: ['restart_server', 'stop_server'],
  },
  {
    label: 'Build',
    icon: 'tools',
    cmds: ['build', 'clean', 'fetch_cache', 'fetch_file_cache'],
  },
  {
    label: 'Setup',
    icon: 'beaker',
    gated: true,
    cmds: ['install_elan', 'update_elan', 'install_deps', 'select_toolchain'],
  },
];
</script>

<template>
  <MockCard
    title="lean_project"
    icon="tools"
    sub="project-wide commands · no target file"
    class="lean-cmds"
  >
    <div class="lc-groups">
      <div v-for="g in groups" :key="g.label" class="lc-group">
        <div class="f-label lc-glabel">
          <wa-icon library="texra" :name="g.icon"></wa-icon>
          {{ g.label }}
          <span v-if="g.gated" class="lc-gate">
            <wa-icon library="texra" name="lock"></wa-icon>VS Code only
          </span>
        </div>
        <div class="lc-pills">
          <code
            v-for="c in g.cmds"
            :key="c"
            class="lc-pill"
            :class="{ gated: g.gated }"
            >{{ c }}</code
          >
        </div>
      </div>
    </div>
  </MockCard>
</template>

<style scoped>
/* Frameless card via <MockCard>; this file adds the grouped-pill layout only.
   All colour / dimension comes from the shared --mk-* tokens. */
.lc-groups {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  margin-top: var(--mk-space-8);
}
.lc-group {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}

.lc-glabel {
  /* .f-label provides the uppercase mono group label; add gate alignment. */
  gap: var(--mk-space-6);
}
.lc-glabel wa-icon {
  color: var(--mk-syn-fn);
}

/* Platform-gate tag on the Setup group — encodes the VS Code-only warning. */
.lc-gate {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-4);
  margin-left: var(--mk-space-6);
  padding: 0 var(--mk-space-6);
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 14%, transparent);
  border-radius: var(--mk-radius-sm);
}
.lc-gate wa-icon {
  font-size: var(--mk-space-10);
  color: var(--mk-accent);
}

.lc-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-6);
}
.lc-pill {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--mk-text);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-4) var(--mk-space-8);
}
/* Gated commands read as muted/locked. */
.lc-pill.gated {
  color: var(--mk-text-faint);
  border-style: dashed;
}
</style>
