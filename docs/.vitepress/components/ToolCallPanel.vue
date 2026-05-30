<script setup>
// Frameless tool-call log: how a tool-use agent drives a tool over a run, as it
// surfaces in the ProgressBoard / CLI. The single most reused mockup shape in
// the docs (memory, zotero, tikz, lean, cli-chat all share it), so it is a
// reusable primitive: pass a tool name + a list of calls.
//
// Composes MockupPanel (frameless card + header) and StatusPill (the verb
// chips), and uses a bridged Web Awesome <wa-spinner> for the in-flight row —
// the spinner themes to --mk-* via the bridge in theme/mockup.css.
import MockupPanel from './MockupPanel.vue';
import StatusPill from './StatusPill.vue';

defineProps({
  // Header label + icon, e.g. title='zotero', icon='book'.
  title: { type: String, default: '' },
  icon: { type: String, default: 'robot' },
  caption: { type: String, default: 'tool calls · this run' },
  // Monospace tool name shown on each row (often the same as title).
  tool: { type: String, default: '' },
  // [{ state: 'done' | 'active', verb, target, effect }]
  calls: { type: Array, default: () => [] },
});
</script>

<template>
  <MockupPanel :title="title" :icon="icon" :caption="caption">
    <ul class="tcp-list">
      <li
        v-for="(c, i) in calls"
        :key="i"
        class="tcp-row"
        :class="{ active: c.state === 'active' }"
      >
        <wa-spinner
          v-if="c.state === 'active'"
          class="tcp-spin mk-spinner"
        ></wa-spinner>
        <span v-else class="tcp-dot"></span>
        <span class="tcp-tool">{{ tool }}</span>
        <StatusPill variant="accent" shape="chip">{{ c.verb }}</StatusPill>
        <span v-if="c.target" class="tcp-target">{{ c.target }}</span>
        <span class="tcp-effect">{{ c.effect }}</span>
      </li>
    </ul>
  </MockupPanel>
</template>

<style scoped>
.tcp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
}
.tcp-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  padding: var(--mk-space-6);
  border-radius: var(--mk-radius-md);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  line-height: 1.5;
}
.tcp-row.active {
  background: color-mix(in srgb, var(--mk-accent) 8%, transparent);
}
.tcp-dot {
  align-self: center;
  width: var(--mk-space-8);
  height: var(--mk-space-8);
  border-radius: 50%;
  background: var(--color-success);
  flex-shrink: 0;
}
/* Bridged Web Awesome spinner for the in-flight row. Sized via font-size; the
   track/indicator colors come from --mk-* so it flips with the theme. */
.tcp-spin {
  align-self: center;
  font-size: var(--mk-space-12);
  flex-shrink: 0;
}
.tcp-tool {
  color: var(--mk-syn-fn);
  font-weight: 600;
  flex-shrink: 0;
}
.tcp-target {
  color: var(--color-text-link);
  word-break: break-all;
  min-width: 0;
}
.tcp-effect {
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
  font-size: var(--mk-fs-72);
  flex: 1;
  min-width: 0;
}
@media (max-width: 560px) {
  .tcp-effect {
    flex-basis: 100%;
    padding-left: var(--mk-space-16);
  }
}
</style>
