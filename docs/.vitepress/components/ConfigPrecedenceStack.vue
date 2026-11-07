<script setup>
// Frameless vertical precedence stack for the CLI's config resolution order.
// The Workspace Defaults section of guide/texra-cli.md states it in one sentence
// — flags over environment variables over the workspace file over the user
// configuration file over built-in defaults — a five-level chain that is easy
// to misremember read left-to-right.
// Stacking the layers top-to-bottom (highest priority on top) with each layer
// carrying its concrete example (a --model flag, TEXRA_MODEL, the stored
// `texra.model` key in each file, the built-in default) makes the override
// order spatial and unambiguous. The approval policy is the exception, stated
// in the footnote: no project file sets it, and its flag and env var only
// narrow the stored policy (packages/cli/src/runtime/platform/cliContext.ts).
//
// Frameless and .mockup-scoped, so it inherits the shared --mk-* tokens and
// flips cleanly between the docs light / dark themes. The "winning" value
// (deepseek/deepseek-flash, set highest) is highlighted via the --mk-accent token.
import StatusPill from './StatusPill.vue';

// Top = highest priority. The first layer wins, so its chip is accented.
const layers = [
  {
    icon: 'terminal',
    rank: '1',
    title: 'CLI flags',
    sub: 'highest priority',
    chip: '--model deepseek/deepseek-flash',
    wins: true,
  },
  {
    icon: 'symbol-variable',
    rank: '2',
    title: 'Environment variables',
    sub: 'shell exports',
    chip: 'TEXRA_MODEL',
    siblings: ['TEXRA_AGENT', 'TEXRA_OUTPUT_FORMAT'],
  },
  {
    icon: 'file-code',
    rank: '3',
    title: 'Workspace file',
    sub: '.texra/config.json',
    chip: '"texra.model": …',
  },
  {
    icon: 'account',
    rank: '4',
    title: 'User configuration file',
    sub: '~/.texra/v1/global-storage/config.json',
    chip: '"texra.model": …',
  },
  {
    icon: 'gear',
    rank: '5',
    title: 'Built-in default',
    sub: 'lowest priority',
    chip: 'deepseek/deepseek-v4-pro',
  },
];
</script>

<template>
  <div
    class="mockup cps"
    role="group"
    aria-label="CLI config precedence: flags over env over workspace file over user configuration file over built-in defaults"
  >
    <span class="cps-rail" aria-hidden="true">overrides ↓</span>
    <ul class="cps-stack">
      <li
        v-for="(l, i) in layers"
        :key="l.title"
        class="cps-layer"
        :class="{ 'cps-layer--top': l.wins }"
      >
        <span class="cps-rank">{{ l.rank }}</span>
        <wa-icon class="cps-ic" library="texra" :name="l.icon"></wa-icon>
        <div class="cps-body">
          <div class="cps-headrow">
            <span class="cps-title">{{ l.title }}</span>
            <span class="cps-sub">{{ l.sub }}</span>
          </div>
          <div class="cps-chips">
            <StatusPill :variant="l.wins ? 'accent' : 'neutral'" shape="chip">{{
              l.chip
            }}</StatusPill>
            <template v-if="l.siblings">
              <StatusPill
                v-for="s in l.siblings"
                :key="s"
                variant="neutral"
                shape="chip"
                >{{ s }}</StatusPill
              >
            </template>
            <StatusPill
              v-if="l.wins"
              variant="success"
              shape="pill"
              icon="check"
              >wins</StatusPill
            >
          </div>
        </div>
        <wa-icon
          v-if="i < layers.length - 1"
          class="cps-arrow"
          library="texra"
          name="chevron-down"
          aria-hidden="true"
        ></wa-icon>
      </li>
    </ul>
  </div>
  <p class="cps-note">
    Approval policy: <code>--approval-policy</code>,
    <code>TEXRA_APPROVAL_POLICY</code> and <code>--no-input</code> only narrow
    the stored <code>texra.approvalPolicy</code>, which a project file cannot
    set.
  </p>
</template>

<style scoped>
.cps-note {
  margin: calc(-1 * var(--mk-space-10)) 0 var(--mk-space-16);
  font-size: var(--mk-fs-72);
  color: var(--mk-text-faint);
}
.cps {
  display: flex;
  align-items: stretch;
  gap: var(--mk-space-8);
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.cps-rail {
  flex-shrink: 0;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: var(--mk-space-4) 0;
}
.cps-stack {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-6);
}
.cps-layer {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--mk-space-9);
  min-width: 0;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-9) var(--mk-space-12);
}
.cps-layer--top {
  border-color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 7%, transparent);
}
.cps-rank {
  flex-shrink: 0;
  width: var(--mk-size-21);
  height: var(--mk-size-21);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: var(--mk-fs-72);
  font-weight: 700;
  color: var(--color-text-secondary);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
}
.cps-layer--top .cps-rank {
  color: var(--mk-accent);
  border-color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
}
.cps-ic {
  flex-shrink: 0;
  font-size: var(--mk-space-14);
  color: var(--mk-text-faint);
}
.cps-layer--top .cps-ic {
  color: var(--mk-accent);
}
.cps-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-5);
}
.cps-headrow {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
}
.cps-title {
  font-size: var(--mk-fs-80);
  font-weight: 700;
  color: var(--mk-text);
}
.cps-sub {
  font-size: var(--mk-fs-68);
  color: var(--mk-text-faint);
}
.cps-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mk-space-5);
}
.cps-arrow {
  position: absolute;
  left: 50%;
  bottom: calc(var(--mk-space-6) * -1);
  transform: translate(-50%, 50%);
  font-size: var(--mk-space-11);
  color: var(--mk-text-faint);
  background: var(--vp-c-bg, var(--mk-bg));
  z-index: 1;
}

@media (max-width: 560px) {
  .cps-rail {
    display: none;
  }
}
</style>
