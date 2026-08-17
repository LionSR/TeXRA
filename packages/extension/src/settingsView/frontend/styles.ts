// Third-party imports
import { css, type CSSResult } from 'lit';

const settingsContainerStyles: CSSResult = css`
  :host {
    display: block;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .settings-container {
    container: settings / inline-size;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .settings-navigation {
    z-index: 2;
    flex: 0 0 auto;
    border-bottom: var(--border-thin) solid var(--border-hairline);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-lowered) 86%,
      var(--wa-color-surface-default)
    );
  }

  .settings-category-nav,
  .settings-page-nav {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
  }

  .settings-category-nav::-webkit-scrollbar,
  .settings-page-nav::-webkit-scrollbar {
    display: none;
  }

  .settings-category-nav {
    gap: var(--wa-space-3xs);
    min-height: var(--height-control);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--border-hairline);
  }

  .settings-page-nav {
    gap: var(--wa-space-3xs);
    min-height: var(--height-control);
    padding: 0 var(--wa-space-xs);
  }

  .settings-category-button,
  .settings-page-button {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .settings-category-button::part(base) {
    justify-content: center;
    min-height: var(--height-control);
    padding: 0 var(--wa-space-xs);
    border: var(--border-thin) solid transparent;
    border-radius: var(--wa-border-radius-pill);
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size);
    font-weight: var(--font-weight);
    letter-spacing: var(--letter-spacing-tight);
    transition:
      background-color var(--transition-fast),
      border-color var(--transition-fast),
      color var(--transition-fast);
  }

  .settings-category-button:hover::part(base) {
    background: var(--surface-hover);
    color: var(--wa-color-text-normal);
  }

  .settings-category-button[data-active='true']::part(base) {
    border-color: var(--border-hairline);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
    box-shadow: var(--wa-shadow-s, none);
  }

  .settings-page-button::part(base) {
    justify-content: center;
    min-height: var(--height-control);
    padding: 0 var(--wa-space-xs);
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight);
    letter-spacing: var(--letter-spacing-tight);
    box-shadow: inset 0 -2px transparent;
    transition:
      background-color var(--transition-fast),
      color var(--transition-fast),
      box-shadow var(--transition-fast);
  }

  .settings-page-button:hover::part(base) {
    background: var(--surface-hover);
    color: var(--wa-color-text-normal);
  }

  .settings-page-button[data-active='true']::part(base) {
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
    box-shadow: inset 0 -2px var(--wa-color-text-normal);
  }

  .settings-category-button wa-icon,
  .settings-page-button wa-icon,
  .settings-unavailable-icon,
  .settings-tab-icon {
    display: grid;
    flex: 0 0 auto;
    width: 1em;
    height: 1em;
    place-items: center;
    line-height: 1;
  }

  .settings-panel {
    flex: 1;
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    padding: var(--wa-space-s);
    overflow: auto;
    overscroll-behavior: contain;
  }

  .settings-page-header {
    margin-bottom: var(--wa-space-s);
    padding-bottom: var(--wa-space-s);
    border-bottom: var(--border-thin) solid var(--border-hairline);
  }

  .settings-page-header-copy {
    min-width: 0;
  }

  .settings-page-header h1 {
    margin: 0;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-h1);
    font-weight: var(--wa-font-weight-semibold);
    line-height: var(--line-height-heading);
  }

  .settings-page-header p {
    margin: var(--wa-space-3xs) 0 0;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .settings-unavailable {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
    max-width: 640px;
    color: var(--color-text-secondary);
  }

  .settings-unavailable-title {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    color: var(--text-color);
    font-weight: var(--font-weight-medium);
  }

  @container settings (max-width: 520px) {
    .settings-category-nav,
    .settings-page-nav {
      padding-inline: var(--wa-space-2xs);
      scrollbar-width: thin;
    }

    .settings-page-button::part(base) {
      width: var(--height-control);
      gap: 0;
      place-content: center;
      padding: 0;
    }

    .settings-page-button::part(start) {
      margin: 0;
    }

    .settings-page-button wa-icon {
      margin-inline-end: 0;
    }

    .settings-page-button::part(label) {
      display: none;
    }

    .settings-panel {
      padding: var(--wa-space-xs);
    }

    .settings-page-header {
      padding-bottom: var(--wa-space-xs);
    }
  }
`;

export const settingsViewStyles = [settingsContainerStyles];
