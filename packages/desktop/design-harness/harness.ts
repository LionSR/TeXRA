// Design harness: renders the proposed shell layouts with the real TeXRA
// components (run-tabs, run-header, follow-up-input) and Web Awesome
// controls on fixture data. Untracked; screenshots feed the design canvas.
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import '../src/renderer/styles.css';
import '../src/renderer/themeTokens.css';
import '../src/renderer/designTokens';
import '../src/renderer/desktopShell.css';
import '@ui/wa';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
// The components only: the progress entry mounts a live session, which the
// harness replaces with fixtures.
import '@progressView/frontend/ProgressApp';
import { html, render, type TemplateResult } from 'lit';

import { desktopScenes } from './scenes/desktop';
import { extensionScenes } from './scenes/extension';
import { RUN_BOARD_FIXTURES, runBoardScene } from './scenes/runBoard';
// ── small pieces ────────────────────────────────────────────────────────
const extFrame = (inner: TemplateResult) =>
  html` <div class="h-ext" id="frame">
    <div class="h-vscode-strip">
      <span>New Agent</span><span class="active">TeXRA</span
      ><span>Terminal</span>
    </div>
    ${inner}
  </div>`;

// ── scenes ──────────────────────────────────────────────────────────────
const runBoardScenes = Object.fromEntries(
  Object.entries(RUN_BOARD_FIXTURES).map(([name, fold]) => [
    name,
    () => extFrame(runBoardScene(fold)),
  ]),
);

// ── styles for the harness chrome (tokens only; components bring their own) ──
const style = html`<style>
  body {
    margin: 0;
    background: var(--wa-color-surface-lowered);
  }
  #app {
    padding: 24px;
    display: grid;
    place-items: start;
  }

  .ok {
    color: var(--wa-color-success-on-quiet, #1a7f37);
  }
  .err {
    color: var(--wa-color-danger-on-quiet, #a4381e);
  }
  .warn {
    color: var(--wa-color-warning-on-quiet, #bf8700);
  }
  .run {
    color: var(--wa-color-success-on-quiet, #1a7f37);
    font-size: 8px;
  }

  /* extension frame: VS Code Light Modern surface, system font */
  .h-ext {
    position: relative;
    width: 420px;
    height: 760px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-family:
      -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    border: 1px solid var(--wa-color-surface-border);
  }
  .h-vscode-strip {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 34px;
    padding: 0 12px;
    border-bottom: 1px solid var(--wa-color-surface-border);
    background: var(--wa-color-surface-lowered);
    color: var(--wa-color-text-quiet);
  }
  .h-vscode-strip .active {
    padding: 3px 8px;
    border-radius: 5px;
    background: var(--wa-color-surface-border);
    color: var(--wa-color-text-normal);
  }

  .h-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  follow-up-input {
    display: block;
    padding: 0 8px 8px;
  }

  /* desktop frame: the real shell classes from desktopShell.css */
  .h-desktop {
    display: grid;
    grid-template-columns: 288px minmax(0, 1fr) 240px;
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    border: 1px solid var(--wa-color-surface-border);
  }
  .h-desktop .shell-sidebar-brand {
    padding-left: 12px;
  }

  .h-conv-col {
    width: min(760px, 100%);
    margin: 0 auto;
    overflow: hidden;
    padding: 12px 0 0;
  }
  .h-conv-col .h-transcript {
    padding: 12px 0;
  }
  .h-conv-col .h-tool {
    font-size: 13px;
    min-height: 34px;
  }

  .h-dock {
    width: min(760px, 100%);
    margin: 0 auto;
    padding: 12px 0 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .h-dock follow-up-input {
    padding: 0;
  }

  .h-ext-wide {
    width: 1100px;
  }

  .h-wide-col .h-body {
    flex: 1 1 auto;
  }

  .h-conv-col .h-phases {
    padding: 6px 0 0;
  }
</style>`;

const scenes: Record<string, () => TemplateResult> = {
  ...extensionScenes,
  ...runBoardScenes,
  ...desktopScenes,
};
const scene =
  new URLSearchParams(location.search).get('scene') ?? 'ext-session';
render(
  html`${style}${(scenes[scene] ?? scenes['ext-session'])()}`,
  document.getElementById('app')!,
);
