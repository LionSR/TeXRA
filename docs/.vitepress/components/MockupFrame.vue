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

const LOGO = withBase('/logo-icon-board.svg');
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
      <nav class="activity-bar">
        <span class="activity-item"
          ><wa-icon library="texra" name="files"></wa-icon
        ></span>
        <span class="activity-item"
          ><wa-icon library="texra" name="search"></wa-icon
        ></span>
        <span class="activity-item"
          ><wa-icon library="texra" name="source-control"></wa-icon
        ></span>
        <span class="activity-item"
          ><wa-icon library="texra" name="debug-alt"></wa-icon
        ></span>
        <span class="activity-item activity-item--active"
          ><img class="activity-logo" :src="LOGO" alt="TeXRA"
        /></span>
        <span class="activity-item activity-bottom"
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
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  position: relative;
  container: mockup-frame / inline-size;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 24px 60px -20px rgba(0, 0, 0, 0.55),
    0 8px 20px -12px rgba(111, 56, 122, 0.45);
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
  min-width: 0;
  max-width: 100%;
}
.win-content {
  display: flex;
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

/* Activity bar */
.activity-bar {
  flex-shrink: 0;
  width: var(--mk-size-46);
  background: var(--mk-bg-raised);
  border-right: 1px solid var(--mk-border-strong);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--mk-space-10) 0;
  gap: var(--mk-space-16);
  box-sizing: border-box;
}
.activity-item {
  color: var(--mk-text-faint);
  width: var(--mk-size-46);
  height: var(--mk-size-32);
  flex: 0 0 var(--mk-size-32);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  font-size: var(--mk-space-20);
  line-height: 1;
  box-sizing: border-box;
  overflow: hidden;
}
.activity-item > wa-icon {
  display: block;
  width: var(--mk-space-20);
  height: var(--mk-space-20);
  line-height: 1;
}
.activity-item--active {
  color: var(--mk-text);
}
.activity-item--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--mk-space-2);
  background: var(--mk-accent);
}
.activity-logo {
  width: var(--mk-size-23);
  height: var(--mk-size-23);
  display: block;
}
.activity-bottom {
  margin-top: auto;
}

@media (max-width: 820px) {
  .win-body {
    flex-direction: column;
  }
  .win-content {
    flex-direction: column;
  }
  .activity-bar {
    flex-direction: row;
    width: auto;
    justify-content: flex-start;
    gap: var(--mk-space-18);
    padding: 0 var(--mk-space-12);
    height: var(--mk-size-40);
    border-right: none;
    border-bottom: 1px solid var(--mk-border-strong);
  }
  .activity-item--active::before {
    left: 0;
    top: auto;
    bottom: 0;
    right: 0;
    width: auto;
    height: var(--mk-space-2);
  }
  .win-title {
    margin-right: 0;
  }
}

@container mockup-frame (max-width: 640px) {
  .win-body {
    flex-direction: column;
  }
  .win-content {
    flex-direction: column;
  }
  .activity-bar {
    flex-direction: row;
    width: auto;
    justify-content: flex-start;
    gap: var(--mk-space-8);
    padding: 0 var(--mk-space-10);
    height: var(--mk-size-40);
    border-right: none;
    border-bottom: 1px solid var(--mk-border-strong);
    overflow: hidden;
  }
  .activity-item {
    width: var(--mk-size-36);
    flex: 0 1 var(--mk-size-36);
  }
  .activity-item--active::before {
    left: 0;
    top: auto;
    bottom: 0;
    right: 0;
    width: auto;
    height: var(--mk-space-2);
  }
  .win-title {
    margin-right: 0;
  }
}
</style>
