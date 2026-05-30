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
/* The VS Code surface tokens (--editor-bg, --color-*, --brand, the litStyles
   aliases) now live on `.mockup` in theme/mockup.css — shared by both this
   full-window frame and the frameless MockupPanel — so this scoped block keeps
   only the window's own visual styling. `.win` always carries `.mockup`, so it
   still inherits every alias. */
.win {
  text-align: left;
  background: var(--editor-bg);
  border: 1px solid var(--mk-border-strong);
  border-radius: var(--mk-radius-window);
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
  gap: var(--mk-space-8);
  height: var(--mk-size-38);
  padding: 0 var(--mk-space-14);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border-strong);
}
.dot {
  width: var(--mk-space-12);
  height: var(--mk-space-12);
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
  font-size: var(--mk-fs-80);
  color: var(--mk-text-dim);
  font-family: var(--vp-font-family-mono);
  margin-right: var(--mk-size-48);
}
.win-body {
  display: flex;
  min-height: var(--mk-size-470);
}
.win-content {
  display: flex;
  flex: 1;
  min-width: 0;
}

/* Activity bar */
.act {
  flex-shrink: 0;
  width: var(--mk-size-46);
  background: var(--mk-bg-raised);
  border-right: 1px solid var(--mk-border-strong);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--mk-space-10) 0;
  gap: var(--mk-space-16);
}
.act-i {
  color: var(--mk-text-faint);
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: var(--mk-space-2) 0;
  font-size: var(--mk-space-20);
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
  width: var(--mk-space-2);
  background: var(--mk-accent);
}
.act-logo {
  width: var(--mk-size-23);
  height: var(--mk-size-23);
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
    gap: var(--mk-space-18);
    padding: 0 var(--mk-space-12);
    height: var(--mk-size-40);
    border-right: none;
    border-bottom: 1px solid var(--mk-border-strong);
  }
  .act-on::before {
    left: -2px;
    top: auto;
    bottom: 0;
    right: -2px;
    width: auto;
    height: var(--mk-space-2);
  }
  .win-title {
    margin-right: 0;
  }
}
</style>
