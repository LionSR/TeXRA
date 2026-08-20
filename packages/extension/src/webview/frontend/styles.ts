/**
 * Main view styles for MainApp component.
 *
 * These styles apply to MainApp's Shadow DOM template content.
 * Shared component styles are in fileSelectStyles.ts.
 */

// Third-party imports
import { css, type CSSResult } from 'lit';

export const mainViewStyles: CSSResult = css`
  :host {
    background-color: transparent;
    color: var(--text-color);
    font-weight: var(--font-weight);
    min-height: 100vh;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .file-selection {
    margin-bottom: var(--wa-space-s);
  }

  .file-selection-group {
    background: transparent;
    border: none;
    padding: var(--wa-space-2xs) 0 0;
    margin: 0;
    overflow: visible;
  }

  /* The desktop shell gives MainApp a bounded pane instead of a webview-sized
     document. Keep the extension's viewport contract above and opt into the
     pane contract only when Electron marks the host element. */
  :host([data-desktop-view]) {
    height: 100%;
    min-height: 0;
  }

  .desktop-launcher {
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--wa-color-surface-default);
  }

  .desktop-launcher-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
  }

  .desktop-launcher-canvas {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--wa-space-m);
    width: min(760px, 100%);
    min-height: 100%;
    margin: 0 auto;
    padding: clamp(32px, 8vh, 80px) clamp(20px, 4vw, 48px) 28px;
  }

  .desktop-launcher-hero {
    display: grid;
    justify-items: center;
    gap: var(--wa-space-xs);
    max-width: 640px;
    margin: 0 auto;
    text-align: center;
  }

  .desktop-launcher-mark {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border: var(--border-thin) solid
      color-mix(
        in srgb,
        var(--wa-color-brand-fill-loud) 24%,
        var(--wa-color-surface-border)
      );
    border-radius: var(--wa-border-radius-l);
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-brand-on-quiet);
    font-size: var(--font-size-icon);
  }

  .desktop-launcher-hero h1 {
    margin: 0;
    color: var(--wa-color-text-normal);
    font-size: clamp(
      var(--font-size-h1),
      3vw,
      calc(var(--font-size-prose, var(--font-size-lg)) * 2)
    );
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
    letter-spacing: var(--letter-spacing-tight);
  }

  .desktop-launcher-hero p {
    max-width: 54ch;
    margin: 0;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-prose, var(--font-size-lg));
    line-height: var(--line-height-prose, var(--line-height-relaxed));
  }

  .desktop-launcher-banners {
    display: grid;
    gap: var(--wa-space-xs);
  }

  .desktop-file-context {
    overflow: hidden;
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-l);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-raised) 70%,
      transparent
    );
  }

  .desktop-file-context summary {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-height: 44px;
    padding: 0 var(--wa-space-s);
    color: var(--wa-color-text-normal);
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .desktop-file-context summary::-webkit-details-marker {
    display: none;
  }

  .desktop-file-context-chevron {
    display: block;
    flex: 0 0 auto;
    width: 1em;
    height: 1em;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-icon-sm);
    line-height: var(--line-height-tight);
    transform: rotate(0deg);
    transition: transform var(--transition-fast);
  }

  .desktop-file-context[open] summary {
    border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .desktop-file-context[open] .desktop-file-context-chevron {
    transform: rotate(90deg);
  }

  .desktop-file-context-label {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    min-width: 0;
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
  }

  .desktop-file-context-label wa-icon {
    display: block;
    flex: 0 0 auto;
    width: 1em;
    height: 1em;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-icon-sm);
    line-height: var(--line-height-tight);
  }

  .desktop-file-context-count {
    margin-inline-start: auto;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
  }

  .desktop-file-context-body {
    max-height: min(38vh, 360px);
    padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-s);
    overflow: auto;
  }

  .desktop-file-context .file-selection-group {
    padding-top: 0;
  }

  .desktop-composer-dock {
    position: relative;
    z-index: 2;
    flex: 0 0 auto;
    padding: 12px clamp(20px, 4vw, 48px) 18px;
    background: linear-gradient(
      to bottom,
      transparent,
      var(--wa-color-surface-default) 26%
    );
  }

  .desktop-composer-dock instruction-panel {
    display: block;
    width: min(760px, 100%);
    margin: 0 auto;
  }

  .desktop-onboarding-canvas {
    min-height: 100%;
  }

  .desktop-onboarding-canvas .main-content {
    box-sizing: border-box;
    justify-content: center;
    width: min(760px, 100%);
    margin: 0 auto;
    padding: clamp(24px, 7vh, 72px) clamp(20px, 4vw, 48px);
    overflow: auto;
  }

  /* A real loading surface prevents the blank pane that previously appeared
     while the host derived onboarding state. Its geometry mirrors the finished
     welcome + composer layout, so the transition does not jump. Shapes are
     wa-skeleton; we only size them and retint the sheen to our surfaces. */
  .launcher-loading {
    display: grid;
    place-items: center;
    min-height: 0;
    padding: var(--wa-space-l);
  }

  .launcher-loading-canvas {
    box-sizing: border-box;
    display: grid;
    justify-items: center;
    gap: var(--wa-space-xs);
    width: min(620px, 100%);
  }

  .launcher-loading-canvas wa-skeleton {
    --color: var(--wa-color-surface-lowered);
    --sheen-color: var(--wa-color-surface-raised);
    min-height: 0;
  }

  .launcher-loading-canvas wa-skeleton::part(indicator) {
    animation-duration: 1.4s;
  }

  .launcher-loading-mark {
    width: 42px;
    height: 42px;
  }

  .launcher-loading-mark::part(indicator) {
    border-radius: var(--wa-border-radius-l);
  }

  .launcher-loading-title {
    width: min(280px, 58%);
    height: 24px;
    margin-top: var(--wa-space-2xs);
  }

  .launcher-loading-copy {
    width: min(420px, 82%);
    height: 12px;
  }

  .launcher-loading-composer {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    width: 100%;
    min-height: 150px;
    margin-top: clamp(32px, 8vh, 72px);
    padding: var(--wa-space-s);
    border-radius: 26px;
    background: var(--wa-color-surface-lowered);
  }

  .launcher-loading-composer wa-skeleton {
    --color: var(--wa-color-surface-raised);
    --sheen-color: var(--wa-color-surface-default);
  }

  .launcher-loading-prompt {
    width: 72%;
    height: 12px;
  }

  .launcher-loading-controls {
    display: flex;
    gap: var(--wa-space-2xs);
  }

  .launcher-loading-controls wa-skeleton {
    width: 72px;
    height: 28px;
  }

  .launcher-loading-controls wa-skeleton:last-child {
    width: 34px;
    height: 34px;
    margin-inline-start: auto;
  }

  .launcher-loading-controls wa-skeleton:last-child::part(indicator) {
    border-radius: var(--wa-border-radius-circle);
  }

  .desktop-launcher-loading {
    height: 100%;
    min-height: 0;
  }

  .desktop-launcher-loading .launcher-loading {
    flex: 1;
  }

  @media (max-width: 640px) {
    .desktop-launcher-canvas {
      justify-content: flex-start;
      padding-top: var(--wa-space-xl);
    }

    .desktop-launcher-mark {
      width: 36px;
      height: 36px;
    }

    .desktop-composer-dock {
      padding-inline: var(--wa-space-xs);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-file-context-chevron {
      transition: none;
    }

    .launcher-loading-canvas wa-skeleton::part(indicator) {
      animation: none;
    }
  }
`;
