<script setup>
// Frameless illustration of a TeXRA select + its open menu (the Launcher's
// agent / model pickers, the auto-extract checkbox menu). Renders the closed
// control on top and a statically-open menu beneath — it is a figure, not a
// live popover, so it stays inline-flowed and inherits the --mk-* scope.
import StatusPill from './StatusPill.vue';

defineProps({
  // closed control: label above + current value (with optional icon)
  label: { type: String, default: '' },
  value: { type: String, default: '' },
  valueIcon: { type: String, default: '' },
  // grouped menu: [{ label?, items: [{ name, icon, badge, badgeVariant, active, checkbox, checked }] }]
  groups: { type: Array, default: () => [] },
  maxWidth: { type: String, default: '340px' },
  // lay the groups out side by side (each group = one column) to save height
  // when there are many items, e.g. a Tool-use | Workflow split.
  columns: { type: [String, Number], default: 1 },
});
</script>

<template>
  <div class="mockup dm" :style="{ maxWidth }" role="group" :aria-label="label">
    <span v-if="label" class="dm-label">{{ label }}</span>
    <div class="dm-control">
      <wa-icon
        v-if="valueIcon"
        class="dm-cv-ic"
        library="texra"
        :name="valueIcon"
      ></wa-icon>
      <span class="dm-value">{{ value }}</span>
      <wa-icon class="dm-caret" library="texra" name="chevron-down"></wa-icon>
    </div>
    <div
      class="dm-menu"
      :class="{ 'dm-menu--cols': Number(columns) > 1 }"
      :style="Number(columns) > 1 ? { '--dm-cols': String(columns) } : null"
    >
      <div v-for="(g, gi) in groups" :key="gi" class="dm-col">
        <div v-if="g.label" class="dm-group">{{ g.label }}</div>
        <div
          v-for="(it, ii) in g.items"
          :key="ii"
          class="dm-item"
          :class="{ active: it.active }"
        >
          <span v-if="it.checkbox" class="dm-check" :class="{ on: it.checked }">
            <wa-icon library="texra" name="check"></wa-icon>
          </span>
          <wa-icon
            v-else-if="it.icon"
            class="dm-item-ic"
            library="texra"
            :name="it.icon"
          ></wa-icon>
          <span class="dm-name">{{ it.name }}</span>
          <StatusPill
            v-if="it.badge"
            class="dm-badge"
            :variant="it.badgeVariant || 'neutral'"
            >{{ it.badge }}</StatusPill
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dm {
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.dm-label {
  display: block;
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  margin-bottom: var(--mk-space-5);
}
.dm-control {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  background: var(--mk-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-6) var(--mk-space-9);
  font-size: var(--mk-fs-80);
  color: var(--wa-color-text-normal);
}
.dm-cv-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
}
.dm-value {
  font-family: var(--vp-font-family-mono);
}
.dm-caret {
  margin-left: auto;
  font-size: var(--mk-space-11);
  color: var(--color-text-tertiary);
}
.dm-menu {
  margin-top: var(--mk-space-4);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-4);
  box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.55);
}
/* Single-column (default): the column wrapper is transparent so groups + items
   flow exactly as before. Multi-column: each group becomes a side-by-side
   column (e.g. a Tool-use | Workflow split) to save vertical space. */
.dm-col {
  display: contents;
}
.dm-menu--cols {
  display: grid;
  grid-template-columns: repeat(var(--dm-cols, 2), minmax(0, 1fr));
  gap: var(--mk-space-2) var(--mk-space-12);
  align-items: start;
}
.dm-menu--cols .dm-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
@media (max-width: 560px) {
  .dm-menu--cols {
    grid-template-columns: 1fr;
  }
}
.dm-group {
  font-size: var(--mk-fs-62);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: var(--mk-space-6) var(--mk-space-8) var(--mk-space-2);
}
.dm-item {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-5) var(--mk-space-8);
  border-radius: var(--mk-radius);
  font-size: var(--mk-fs-80);
  color: var(--wa-color-text-normal);
}
.dm-item.active {
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
}
.dm-item-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.dm-name {
  font-family: var(--vp-font-family-mono);
  flex: 1;
  min-width: 0;
}
.dm-badge {
  flex-shrink: 0;
}
.dm-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-space-16);
  flex-shrink: 0;
  font-size: var(--mk-space-11);
  color: var(--mk-accent);
  opacity: 0;
}
.dm-check.on {
  opacity: 1;
}
</style>
