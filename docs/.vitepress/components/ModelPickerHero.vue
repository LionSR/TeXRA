<script setup>
// Frameless illustration of the TeXRA model picker: a closed select showing the
// current value, an open list of monospace model ids, and a tooltip/popover
// anchored to the hovered row that renders the context-window + cost estimate
// the prose promises on hover. It is a figure (statically open), so it stays
// inline-flowed and inherits the --mk-* scope — mirrors DropdownMenu styling.
import StatusPill from './StatusPill.vue';

const items = [
  { id: 'opus5T', thinking: true },
  { id: 'opus5', thinking: false },
  {
    id: 'sonnet5T',
    thinking: true,
    hovered: true,
    tip: { context: '1M', input: '$3', output: '$15', mode: 'Thinking' },
  },
  { id: 'sonnet5', thinking: false },
  { id: 'haiku45T', thinking: true },
  { id: 'haiku45', thinking: false },
];
</script>

<template>
  <div class="mockup mp" role="group" aria-label="Model picker">
    <span class="mp-label">Model</span>
    <div class="mp-control">
      <wa-icon class="mp-cv-ic" library="texra" name="cpu"></wa-icon>
      <span class="mp-value">sonnet5T</span>
      <wa-icon class="mp-caret" library="texra" name="chevron-down"></wa-icon>
    </div>
    <div class="mp-menu">
      <div
        v-for="(it, ii) in items"
        :key="ii"
        class="mp-item"
        :class="{ active: it.hovered }"
      >
        <span class="mp-name">{{ it.id }}</span>
        <StatusPill
          v-if="it.thinking"
          class="mp-think"
          variant="accent"
          icon="sparkle"
          >T</StatusPill
        >
        <div v-if="it.tip" class="mp-tip" role="tooltip">
          <wa-icon
            class="mp-tip-arrow"
            library="texra"
            name="caret-left"
          ></wa-icon>
          <div class="mp-tip-row">
            <span class="mp-tip-k">Context</span>
            <span class="mp-tip-v">{{ it.tip.context }}</span>
          </div>
          <div class="mp-tip-row">
            <span class="mp-tip-k">Input</span>
            <span class="mp-tip-v">{{ it.tip.input }} / 1M</span>
          </div>
          <div class="mp-tip-row">
            <span class="mp-tip-k">Output</span>
            <span class="mp-tip-v">{{ it.tip.output }} / 1M</span>
          </div>
          <div class="mp-tip-foot">
            <wa-icon library="texra" name="sparkle"></wa-icon>
            {{ it.tip.mode }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mp {
  margin: var(--mk-space-16) 0;
  max-width: 360px;
  font-family: var(--vp-font-family-base);
}
.mp-label {
  display: block;
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  margin-bottom: var(--mk-space-5);
}
.mp-control {
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
.mp-cv-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
}
.mp-value {
  font-family: var(--vp-font-family-mono);
}
.mp-caret {
  margin-left: auto;
  font-size: var(--mk-space-11);
  color: var(--color-text-tertiary);
}
.mp-menu {
  margin-top: var(--mk-space-4);
  background: var(--mk-bg-raised);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-4);
  box-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.55);
}
.mp-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
  padding: var(--mk-space-5) var(--mk-space-8);
  border-radius: var(--mk-radius);
  font-size: var(--mk-fs-80);
  color: var(--wa-color-text-normal);
}
.mp-item.active {
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
}
.mp-name {
  font-family: var(--vp-font-family-mono);
  flex: 1;
  min-width: 0;
}
.mp-think {
  flex-shrink: 0;
}
/* Anchored tooltip/popover that surfaces the hover-time context + cost info. */
.mp-tip {
  position: absolute;
  left: calc(100% + var(--mk-space-12));
  top: 50%;
  transform: translateY(-50%);
  width: max-content;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-7) var(--mk-space-10);
  box-shadow: 0 8px 22px -10px rgba(0, 0, 0, 0.6);
  font-family: var(--vp-font-family-base);
}
.mp-tip-arrow {
  position: absolute;
  left: calc(-1 * var(--mk-space-10));
  top: 50%;
  transform: translateY(-50%);
  font-size: var(--mk-space-12);
  color: var(--mk-border-soft);
}
.mp-tip-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--mk-space-14);
  font-size: var(--mk-fs-72);
  line-height: 1.7;
}
.mp-tip-k {
  color: var(--color-text-tertiary);
}
.mp-tip-v {
  font-family: var(--vp-font-family-mono);
  color: var(--wa-color-text-normal);
}
.mp-tip-foot {
  display: flex;
  align-items: center;
  gap: var(--mk-space-5);
  margin-top: var(--mk-space-5);
  padding-top: var(--mk-space-5);
  border-top: 1px solid var(--mk-border-soft);
  font-size: var(--mk-fs-68);
  color: var(--mk-accent);
}
@media (max-width: 640px) {
  .mp-tip {
    position: static;
    transform: none;
    margin-top: var(--mk-space-6);
    width: auto;
  }
  .mp-tip-arrow {
    display: none;
  }
  .mp-item:has(.mp-tip) {
    flex-wrap: wrap;
  }
}
</style>
