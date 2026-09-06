// Design harness: renders the proposed shell layouts with the real TeXRA
// components (stream-tabs, stream-header, follow-up-input) and Web Awesome
// controls on fixture data. Untracked; screenshots feed the design canvas.
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import '../src/renderer/styles.css';
import '../src/renderer/themeTokens.css';
import '../src/renderer/taskShell.css';
import '@shared/wa';
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

import { waIcon } from '@shared/wa/webAwesomeIcons';
import { desktopScenes } from './scenes/desktop';
import { extensionScenes } from './scenes/extension';
import { RUN_BOARD_FIXTURES, runBoardScene } from './scenes/runBoard';
// ── small pieces ────────────────────────────────────────────────────────
const iconBtn = (name: Parameters<typeof waIcon>[0], label: string) =>
  html` <wa-button
    appearance="plain"
    size="s"
    class="icon-button"
    aria-label=${label}
    title=${label}
    >${waIcon(name)}</wa-button
  >`;

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
    () => extFrame(runBoardScene(fold, iconBtn)),
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
  .h-quiet {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
  }
  .h-spacer {
    flex: 1 1 auto;
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
  .h-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 38px;
    padding: 0 8px;
    border-bottom: 1px solid var(--wa-color-surface-border);
    flex: 0 0 auto;
  }
  .h-title {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
    padding-left: 4px;
  }
  .h-title span {
    color: var(--wa-color-text-quiet);
  }
  .h-title wa-icon {
    font-size: 10px;
    color: var(--wa-color-text-quiet);
  }
  .h-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .h-transcript {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  .h-user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .h-bubble {
    max-width: 78%;
    padding: 8px 12px;
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
  }
  .h-time {
    font-size: 11px;
    color: var(--wa-color-text-quiet);
  }
  .h-warn {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 4px 6px;
    border-radius: 4px;
    background: var(--wa-color-danger-fill-quiet);
    color: var(--wa-color-danger-on-quiet);
    font-size: 12px;
    line-height: 1.4;
  }
  .h-tool {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 10px;
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-lowered);
    font-size: 12.5px;
  }
  .h-tool wa-icon {
    color: var(--wa-color-text-quiet);
    font-size: 12px;
  }
  .h-tool span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h-stats {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    font-size: 11.5px;
    color: var(--wa-color-text-quiet);
    flex: 0 0 auto;
  }
  .h-stats .h-bar {
    display: inline-block;
    width: 70px;
    height: 5px;
    border: 0;
    padding: 0;
    border-radius: 3px;
    background: var(--wa-color-surface-border);
    position: relative;
  }
  .h-stats .h-bar span {
    position: absolute;
    left: 0;
    top: 0;
    height: 5px;
    width: 2px;
    background: var(--wa-color-text-normal);
    border-radius: 3px;
  }
  .h-routing {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px 2px;
    font-size: 11.5px;
    color: var(--wa-color-text-quiet);
  }
  .h-routing wa-icon {
    font-size: 11px;
  }
  .h-routing a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }
  follow-up-input {
    display: block;
    padding: 0 8px 8px;
  }
  .h-scrim {
    position: absolute;
    inset: 34px 0 0 0;
    background: rgb(0 0 0 / 0.18);
  }
  .h-drawer {
    position: absolute;
    top: 34px;
    bottom: 0;
    left: 0;
    width: 320px;
    display: flex;
    flex-direction: column;
    background: var(--wa-color-surface-default);
    border-right: 1px solid var(--wa-color-surface-border);
    box-shadow: var(--wa-shadow-l, 8px 0 24px rgb(0 0 0 / 0.08));
  }
  .h-drawer-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 4px;
  }
  .h-drawer-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--wa-color-surface-border);
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }
  .h-hero-wrap {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 18px;
    padding: 0 12px;
  }
  .h-hero {
    display: grid;
    justify-items: center;
    gap: 8px;
    text-align: center;
    padding: 0 12px;
  }
  .h-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: var(--wa-border-radius-l);
    border: 1px solid var(--wa-color-brand-border-quiet);
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-brand-on-quiet);
    font-size: 18px;
  }
  .h-hero h1 {
    margin: 4px 0 0;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1.25;
  }
  .h-hero p {
    margin: 0;
    max-width: 34ch;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--wa-color-text-quiet);
  }
  .h-context::part(base) {
    border-radius: var(--wa-border-radius-m);
  }
  .h-context [slot='summary'] {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .h-active {
    padding: 0 8px 4px;
  }
  .h-label {
    padding: 0 8px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--wa-color-text-quiet);
  }
  .h-composer {
    margin: 4px 12px 12px;
    padding: 8px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-l);
    background: var(--wa-color-surface-default);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .h-composer wa-textarea::part(base) {
    border: 0;
    box-shadow: none;
  }
  .h-composer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .h-composer-row wa-select {
    width: 150px;
  }
  .h-composer-row wa-select:nth-of-type(3) {
    width: 124px;
  }
  .h-send::part(base) {
    border-radius: 50%;
    width: 28px;
    height: 28px;
    padding: 0;
  }
  .h-phases {
    padding: 6px 8px 0;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--wa-color-surface-border);
  }
  .h-phases wa-tab {
    font-size: 12px;
  }
  .h-phases wa-tab wa-icon {
    font-size: 10px;
    color: var(--wa-color-brand-on-quiet);
    margin-right: 4px;
  }
  .h-phases wa-tab.declared {
    color: var(--wa-color-text-quiet);
  }
  .h-phases wa-badge {
    margin-left: 6px;
    font-size: 10px;
  }
  .h-phases wa-tab-panel {
    display: none;
  }
  .h-calls {
    display: flex;
    flex-direction: column;
  }
  .h-group {
    display: flex;
    gap: 6px;
    padding: 8px 12px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--wa-color-text-quiet);
  }
  .h-group span {
    font-weight: 500;
  }
  .h-group.warn {
    color: var(--wa-color-warning-on-quiet);
  }
  .h-group.err {
    color: var(--wa-color-danger-on-quiet);
  }
  .h-call {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 12px;
    border-top: 1px solid var(--wa-color-surface-border);
    font-size: 12.5px;
  }
  .h-call > wa-icon {
    font-size: 12px;
    flex: 0 0 auto;
  }
  .h-call > wa-icon:last-child {
    color: var(--wa-color-text-quiet);
  }
  .h-call strong {
    font-weight: 500;
    white-space: nowrap;
  }
  .h-last {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--wa-color-text-quiet);
  }
  .h-meta {
    font-size: 11px;
    color: var(--wa-color-text-quiet);
    white-space: nowrap;
  }
  .h-call wa-button {
    font-size: 11.5px;
  }
  .h-fold {
    margin: 4px 8px;
  }
  .h-fold::part(base) {
    border-radius: var(--wa-border-radius-m);
  }
  .h-fold [slot='summary'] {
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }
  .h-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 12px 12px;
    padding: 6px 8px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-l);
  }

  /* desktop frame: the real shell classes from taskShell.css */
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
  .h-desktop .task-sidebar-brand {
    padding-left: 12px;
  }
  .h-rail-scroll {
    overflow: auto;
  }
  .h-nested {
    padding: 0 0 6px 10px;
  }
  .h-add-paper {
    margin-top: 8px;
    width: 100%;
  }
  .h-conv {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    height: 100%;
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
  .h-prose {
    font-size: 14px;
    line-height: 1.55;
  }
  .h-dock {
    width: min(760px, 100%);
    margin: 0 auto;
    padding: 12px 0 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .h-chips {
    display: flex;
    gap: 6px;
  }
  .h-dock follow-up-input {
    padding: 0;
  }
  .h-paper-chip::part(base) {
    gap: 6px;
  }
  .h-context-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 56px 10px 12px;
    border-left: 1px solid var(--wa-color-surface-border);
  }
  .h-ctx-head {
    padding: 6px 8px;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }
  .h-ctx-head:not(:first-child) {
    margin-top: 10px;
  }
  .h-pdf {
    height: 100%;
    background: var(--wa-color-surface-lowered);
    padding: 16px;
    overflow: hidden;
  }
  .h-page {
    width: 100%;
    max-width: 400px;
    margin: 0 auto;
    aspect-ratio: 1 / 1.3;
    background: #fff;
    box-shadow: var(--wa-shadow-m, 0 2px 8px rgb(0 0 0 / 0.12));
    padding: 36px 32px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .h-pl {
    height: 7px;
    border-radius: 3px;
    background: #d8d8dc;
  }
  .h-pl.short {
    width: 62%;
  }
  .h-pl-title {
    height: 12px;
    width: 70%;
    background: #b9b9bf;
    margin: 0 auto 4px;
  }
  .h-pl-sub {
    width: 40%;
    margin: 0 auto 14px;
  }
  .h-pl-h {
    width: 34%;
    height: 9px;
    background: #b9b9bf;
    margin-top: 10px;
  }
  .h-pl-eq {
    width: 46%;
    margin: 6px auto;
    height: 10px;
  }
  .h-card {
    margin-top: 12px;
    padding: 8px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: 10px;
    background: var(--wa-color-surface-default);
    display: grid;
    gap: 2px;
  }
  .h-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 6px;
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--wa-color-text-quiet);
  }
  .h-card-note {
    padding: 6px 8px 0;
  }
  .h-switcher {
    margin-bottom: 6px;
    width: 100%;
  }
  .h-switcher::part(base) {
    justify-content: flex-start;
    min-height: 44px;
  }
  .h-switcher .task-project-copy {
    text-align: left;
    min-width: 0;
  }
  .h-switcher::part(label) {
    min-width: 0;
    overflow: hidden;
  }
  .h-ext-wide {
    width: 1100px;
  }
  .h-active-btn::part(base) {
    background: var(--wa-color-surface-lowered);
  }
  .h-menu {
    position: absolute;
    right: 8px;
    top: 74px;
    width: 250px;
    padding: 4px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-surface-default);
    box-shadow: var(--wa-shadow-l, 0 8px 28px rgb(0 0 0 / 0.14));
    z-index: 3;
    display: grid;
    gap: 1px;
  }
  .h-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    border-radius: 4px;
    font-size: 12.5px;
  }
  .h-menu-item.active {
    background: var(--wa-color-surface-lowered);
  }
  .h-menu-item wa-icon {
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }
  .h-menu wa-divider {
    --spacing: 4px;
  }
  .h-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 62%;
    display: flex;
    flex-direction: column;
    background: var(--wa-color-surface-default);
    border-top: 1px solid var(--wa-color-surface-border);
    box-shadow: 0 -8px 28px rgb(0 0 0 / 0.1);
    z-index: 2;
  }
  .h-sheet .h-bar {
    padding-left: 12px;
  }
  .h-sheet latexdiffs-section {
    display: block;
    padding: 4px 8px 12px;
    overflow: auto;
  }
  .h-wide {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .h-dock-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--wa-color-surface-border);
    background: var(--wa-color-surface-lowered);
  }
  .h-dock-list .h-bar {
    padding-left: 12px;
  }
  .h-dock-list .h-drawer-body {
    padding: 4px 6px;
  }
  .h-wide-main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .h-wide-col {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    width: min(760px, 100%);
    margin: 0 auto;
  }
  .h-wide-col .h-body {
    flex: 1 1 auto;
  }
  .h-wide-col follow-up-input {
    padding: 0 0 12px;
  }
  .h-wide-col .h-transcript {
    padding: 12px 0;
  }
  .h-wide-col .h-stats,
  .h-wide-col .h-routing {
    padding-left: 0;
    padding-right: 0;
  }
  .h-subtree {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .h-approval {
    margin: 0 4px;
    padding: 10px 12px;
    border: 1px solid var(--wa-color-warning-border-loud, #bf8700);
    border-radius: 10px;
    background: var(--wa-color-warning-fill-quiet, #fff8e6);
    font-size: var(--font-size-sm);
    display: grid;
    gap: 6px;
  }
  .h-approval-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  .h-approval code {
    font-family: var(--wa-font-family-mono);
    font-size: 12px;
  }
  .h-approval-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .h-calls-card {
    border: 1px solid var(--wa-color-surface-border);
    border-radius: 10px;
    overflow: hidden;
    margin-top: 8px;
  }
  .h-calls-card .h-call {
    font-size: 13px;
  }
  .h-calls-card .h-group:first-child {
    padding-top: 10px;
  }
  .h-conv-col .h-phases {
    padding: 6px 0 0;
  }
  .h-run-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 4px 0;
    font-size: 13px;
  }
  .h-prose-sm {
    font-size: 13px;
    line-height: 1.5;
    padding: 2px 2px 0;
  }
  .h-proposal {
    border: 1px solid var(--wa-color-warning-border-loud, #bf8700);
    border-radius: var(--wa-border-radius-l);
    overflow: hidden;
    background: var(--wa-color-surface-default);
  }
  .h-proposal-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 10px;
    background: var(--wa-color-warning-fill-quiet, #fff8e6);
    font-size: 12.5px;
  }
  .h-proposal-head wa-icon {
    color: var(--wa-color-warning-on-quiet, #bf8700);
  }
  .h-proposal-lede {
    padding: 8px 10px 4px;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .h-plan-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 10px;
    border-top: 1px solid var(--wa-color-surface-border);
    font-size: 12.5px;
  }
  .h-plan-row wa-icon {
    font-size: 10px;
    color: var(--wa-color-text-quiet);
  }
  .h-plan-row strong {
    font-weight: 500;
  }
  .h-proposal-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--wa-color-surface-border);
  }
  .h-dispatch::part(base) {
    border-radius: var(--wa-border-radius-l);
  }
  .h-dispatch::part(content) {
    padding: 0;
  }
  .h-dispatch [slot='summary'] {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 500;
  }
  .h-dispatch wa-badge {
    font-size: 10px;
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
