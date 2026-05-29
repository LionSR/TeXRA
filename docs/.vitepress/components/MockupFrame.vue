<script setup>
// Shared VS Code / TeXRA window chrome for the docs product mockups. Owns the
// traffic-light title bar, the activity bar with the real logo, and the design
// tokens (mirrored from src/shared/styles/litStyles.ts + Web Awesome) that the
// slotted body consumes. Page heroes drop their sidebar + editor into the
// default slot.
import { withBase } from 'vitepress';

defineProps({
  title: { type: String, default: 'texra-paper' },
});

const LOGO = withBase('/logo-128x128.svg');
</script>

<template>
  <div class="win mockup" role="group">
    <div class="win-bar">
      <span class="dot dot-r"></span>
      <span class="dot dot-y"></span>
      <span class="dot dot-g"></span>
      <span class="win-title">{{ title }}</span>
    </div>
    <div class="win-body">
      <nav class="act">
        <span class="act-i"
          ><wa-icon library="texra" name="files"></wa-icon
        ></span>
        <span class="act-i"
          ><wa-icon library="texra" name="search"></wa-icon
        ></span>
        <span class="act-i"
          ><wa-icon library="texra" name="source-control"></wa-icon
        ></span>
        <span class="act-i"
          ><wa-icon library="texra" name="debug-alt"></wa-icon
        ></span>
        <span class="act-i act-on"
          ><img class="act-logo" :src="LOGO" alt="TeXRA"
        /></span>
        <span class="act-i act-bottom"
          ><wa-icon library="texra" name="settings-gear"></wa-icon
        ></span>
      </nav>
      <div class="win-content">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* These VS Code surface tokens are now aliases over the theme-adaptive
   --mk-* palette (defined in mockup.css), so the slotted chrome flips with the
   docs theme instead of being locked to the dark webview values. */
.win {
  --wa-space-3xs: 2px;
  --wa-space-2xs: 4px;
  --wa-space-xs: 8px;
  --wa-space-s: 12px;
  --border-thin: 1px;
  --border-medium: 2px;
  --border-radius-small: 2px;
  --border-radius: 3px;
  --border-radius-large: 6px;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  --editor-bg: var(--mk-bg);
  --surface-bg: var(--mk-bg-deep);
  --panel-bg: var(--mk-bg-soft);
  --color-border: var(--mk-bg-raised);
  --wa-color-text-normal: var(--mk-text-dim);
  --color-text-secondary: var(--mk-text-faint);
  --color-text-tertiary: var(--mk-text-faint);
  --color-text-link: var(--mk-syn-fn);
  --color-success: #2ea043;
  --color-warning: #cca700;
  --color-error: #f14c4c;
  --wa-color-icon-info: var(--mk-syn-fn);
  --wa-color-debug-name: #4b9ef9;
  --brand: var(--mk-accent);

  text-align: left;
  background: var(--editor-bg);
  border: 1px solid var(--mk-border-strong);
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 24px 60px -20px rgba(0, 0, 0, 0.55),
    0 8px 20px -12px rgba(77, 33, 97, 0.45);
}
.win-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border-strong);
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
}
.dot-r {
  background: #ff5f57;
}
.dot-y {
  background: #febc2e;
}
.dot-g {
  background: #28c840;
}
.win-title {
  flex: 1;
  text-align: center;
  font-size: 0.8rem;
  color: var(--mk-text-dim);
  font-family: var(--vp-font-family-mono);
  margin-right: 48px;
}
.win-body {
  display: flex;
  min-height: 470px;
}
.win-content {
  display: flex;
  flex: 1;
  min-width: 0;
}

/* Activity bar */
.act {
  flex-shrink: 0;
  width: 46px;
  background: var(--mk-bg-raised);
  border-right: 1px solid var(--mk-border-strong);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 16px;
}
.act-i {
  color: var(--mk-text-faint);
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 2px 0;
  font-size: 20px;
}
.act-on {
  color: var(--mk-text);
}
.act-on::before {
  content: '';
  position: absolute;
  left: 0;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--mk-accent);
}
.act-logo {
  width: 23px;
  height: 23px;
  display: block;
}
.act-bottom {
  margin-top: auto;
}

@media (max-width: 820px) {
  .win-body {
    flex-direction: column;
  }
  .win-content {
    flex-direction: column;
  }
  .act {
    flex-direction: row;
    width: auto;
    justify-content: flex-start;
    gap: 18px;
    padding: 0 12px;
    height: 40px;
    border-right: none;
    border-bottom: 1px solid var(--mk-border-strong);
  }
  .act-on::before {
    left: -2px;
    top: auto;
    bottom: 0;
    right: -2px;
    width: auto;
    height: 2px;
  }
  .win-title {
    margin-right: 0;
  }
}
</style>
