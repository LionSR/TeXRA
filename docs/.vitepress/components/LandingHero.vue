<script setup>
import { ref } from 'vue';
import { withBase } from 'vitepress';
import MockupSidebar from './MockupSidebar.vue';
import MockupResult from './MockupResult.vue';

// Which file the editor pane shows; shared with both mockup children so the
// sidebar's tool-use rows and the editor tabs stay in sync.
const view = ref('diff');
const installOpen = ref(false);
const copied = ref(false);

const CLI = 'npm install -g @texra-ai/cli';

// Real product logo, served from docs/public.
const LOGO = withBase('/logo-128x128.svg');

// Editors all resolve to their respective marketplaces; Cursor, Windsurf and
// other VS Code forks install TeXRA from Open VSX.
const editors = [
  {
    name: 'VS Code',
    note: 'Marketplace',
    href: 'https://marketplace.visualstudio.com/items?itemName=texra-ai.texra',
  },
  {
    name: 'Cursor',
    note: 'Open VSX',
    href: 'https://open-vsx.org/extension/texra-ai/texra',
  },
  {
    name: 'Windsurf',
    note: 'Open VSX',
    href: 'https://open-vsx.org/extension/texra-ai/texra',
  },
  {
    name: 'Other editors',
    note: 'Open VSX',
    href: 'https://open-vsx.org/extension/texra-ai/texra',
  },
];

async function copyCli() {
  try {
    await navigator.clipboard.writeText(CLI);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable or write denied — leave label unchanged */
  }
}
</script>

<template>
  <div class="lh">
    <p class="lh-eyebrow">Multi-agent AI for theorists</p>
    <h1 class="lh-headline">
      Derive it, check it,<br />
      write it into your paper.
    </h1>
    <p class="lh-tagline">
      You direct an orchestrator. It delegates to specialist agents that search
      real databases, compute in Wolfram, prove in Lean&nbsp;4 — and hand back
      every change as a diff you approve. In VS&nbsp;Code, its forks, and the
      terminal.
    </p>

    <div class="lh-actions">
      <a class="lh-btn lh-btn-primary" :href="withBase('/guide/quick-start')"
        >Get started</a
      >
      <div class="lh-install">
        <button
          type="button"
          class="lh-btn lh-btn-alt lh-install-trigger"
          :aria-expanded="installOpen"
          @click="installOpen = !installOpen"
        >
          Add to your editor
          <span class="lh-caret" :class="{ open: installOpen }">▾</span>
        </button>
        <div v-show="installOpen" class="lh-menu" role="menu">
          <a
            v-for="e in editors"
            :key="e.name"
            class="lh-menu-item"
            role="menuitem"
            :href="e.href"
            target="_blank"
            rel="noopener"
            @click="installOpen = false"
          >
            <span class="lh-menu-name">{{ e.name }}</span>
            <span class="lh-menu-note">{{ e.note }}</span>
          </a>
        </div>
      </div>
    </div>

    <!-- CLI install, kept prominent -->
    <div class="lh-cli">
      <span class="lh-cli-label">or run it anywhere from your terminal</span>
      <div class="lh-cli-pill">
        <code><span class="lh-cli-dollar">$</span> {{ CLI }}</code>
        <button type="button" class="lh-copy" @click="copyCli">
          {{ copied ? 'copied' : 'copy' }}
        </button>
      </div>
    </div>

    <div
      v-show="installOpen"
      class="lh-backdrop"
      @click="installOpen = false"
    ></div>

    <!-- Product slice: a real TeXRA run, not a marketing illustration -->
    <div
      class="win"
      role="group"
      aria-label="TeXRA running an orchestrated research task in VS Code"
    >
      <div class="win-bar">
        <span class="dot dot-r"></span>
        <span class="dot dot-y"></span>
        <span class="dot dot-g"></span>
        <span class="win-title">spectral-gap — texra-paper</span>
      </div>
      <div class="win-body">
        <!-- VS Code activity bar -->
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

        <!-- Left: TeXRA sidebar (Progress tab). Right: the resulting files. -->
        <MockupSidebar v-model:view="view" />
        <MockupResult v-model:view="view" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.lh {
  max-width: 1080px;
  margin: 0 auto;
  padding: 3.5rem 1.5rem 0;
  text-align: center;
  position: relative;
}
.lh-eyebrow {
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin: 0 0 1rem;
}
.lh-headline {
  font-size: clamp(2.1rem, 5.4vw, 3.6rem);
  line-height: 1.07;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
  margin: 0 auto 1.25rem;
  border: none;
}
.lh-tagline {
  max-width: 640px;
  margin: 0 auto 1.75rem;
  font-size: 1.05rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

/* ---- Actions: Get started + editor dropdown ---- */
.lh-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  position: relative;
  z-index: 30;
}
.lh-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.7rem 1.5rem;
  border-radius: 9px;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none !important;
  cursor: pointer;
  font-family: inherit;
  transition:
    transform 0.15s,
    background-color 0.2s,
    border-color 0.2s;
}
.lh-btn:hover {
  transform: translateY(-1px);
  text-decoration: none !important;
}
.lh-btn-primary {
  background: var(--vp-c-brand-1);
  color: #fff !important;
  border: 1px solid var(--vp-c-brand-1);
}
.lh-btn-primary:hover {
  background: var(--vp-c-brand-2);
}
.lh-btn-alt {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1) !important;
  border: 1px solid var(--vp-c-divider);
}
.lh-btn-alt:hover {
  border-color: var(--vp-c-brand-1);
}
.lh-install {
  position: relative;
}
.lh-caret {
  font-size: 0.7rem;
  transition: transform 0.2s;
}
.lh-caret.open {
  transform: rotate(180deg);
}
.lh-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  min-width: 230px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 11px;
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.3);
  padding: 0.4rem;
  z-index: 40;
}
.lh-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.7rem;
  border-radius: 7px;
  text-decoration: none !important;
  color: var(--vp-c-text-1) !important;
}
.lh-menu-item:hover {
  background: var(--vp-c-brand-soft);
}
.lh-menu-name {
  font-weight: 600;
  font-size: 0.9rem;
}
.lh-menu-note {
  font-size: 0.74rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}
.lh-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}

/* ---- CLI pill ---- */
.lh-cli {
  margin-bottom: 3rem;
}
.lh-cli-label {
  display: block;
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
  margin-bottom: 0.5rem;
}
.lh-cli-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  padding: 0.5rem 0.5rem 0.5rem 0.9rem;
  max-width: 100%;
}
.lh-cli-pill code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  overflow-x: auto;
  background: none;
  padding: 0;
}
.lh-cli-dollar {
  color: var(--vp-c-brand-1);
  margin-right: 0.35rem;
  user-select: none;
}
.lh-copy {
  flex-shrink: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}
.lh-copy:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

/* ============================================
   PRODUCT WINDOW — faithful TeXRA / VS Code

   The token block below mirrors the design tokens the real webview
   components use (src/shared/styles/litStyles.ts + Web Awesome), resolved to
   the dark VS Code surface values the extension gets from the host theme (the
   docs site has no --vscode-* / dark --wa-* theme). They inherit into the
   MockupSidebar / MockupResult children, which consume them.
   ============================================ */
.win {
  /* Spacing scale (Web Awesome) */
  --wa-space-3xs: 2px;
  --wa-space-2xs: 4px;
  --wa-space-xs: 8px;
  --wa-space-s: 12px;
  /* Borders & radii (litStyles designTokens) */
  --border-thin: 1px;
  --border-medium: 2px;
  --border-radius-small: 2px;
  --border-radius: 3px;
  --border-radius-large: 6px;
  /* Weights */
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  /* Surfaces / text (dark editor host theme) */
  --editor-bg: #1e1e1e;
  --surface-bg: #181818;
  --panel-bg: #252526;
  --color-border: #2a2a2a;
  --wa-color-text-normal: #cccccc;
  --color-text-secondary: #8a8a8a;
  --color-text-tertiary: #6f6f6f;
  --color-text-link: #4daafc;
  /* Status colors (litStyles designTokens fallbacks + logEntryStyles) */
  --color-success: #2ea043;
  --color-warning: #cca700;
  --color-error: #f14c4c;
  --wa-color-icon-info: #75beff;
  --wa-color-debug-name: #4b9ef9;
  --brand: #c89be0;

  text-align: left;
  background: var(--editor-bg);
  border: 1px solid #000;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  z-index: 1;
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
  background: #323233;
  border-bottom: 1px solid #000;
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
  color: #b4b4b4;
  font-family: var(--vp-font-family-mono);
  margin-right: 48px;
}
.win-body {
  display: grid;
  grid-template-columns: 46px 340px 1fr;
  min-height: 440px;
}

/* Activity bar */
.act {
  background: #2c2c2c;
  border-right: 1px solid #000;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 16px;
}
.act-i {
  color: #858585;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 2px 0;
  font-size: 20px;
}
.act-on {
  color: #fff;
}
.act-on::before {
  content: '';
  position: absolute;
  left: 0;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: #c89be0;
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
    grid-template-columns: 1fr;
  }
  .act {
    flex-direction: row;
    justify-content: flex-start;
    gap: 18px;
    padding: 0 12px;
    height: 40px;
    border-right: none;
    border-bottom: 1px solid #000;
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
@media (max-width: 760px) {
  .lh {
    padding-top: 2.5rem;
  }
}
</style>
