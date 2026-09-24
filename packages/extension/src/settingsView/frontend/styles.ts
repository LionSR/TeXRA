// Third-party imports
import { css, type CSSResult } from 'lit';

export const settingsViewStyles: CSSResult[] = [
  css`
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

    .settings-page-nav {
      display: flex;
      align-items: center;
      min-width: 0;
      overflow-x: auto;
      overscroll-behavior-inline: contain;
      scrollbar-width: none;
    }

    .settings-page-nav::-webkit-scrollbar {
      display: none;
    }

    .settings-page-nav {
      gap: var(--wa-space-3xs);
      min-height: var(--height-control);
      padding: 0 var(--wa-space-xs);
    }

    .settings-page-button {
      flex: 0 0 auto;
      white-space: nowrap;
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

    .settings-page-button wa-icon,
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

    @container settings (max-width: 520px) {
      .settings-page-nav {
        padding-inline: var(--wa-space-2xs);
        scrollbar-width: thin;
      }

      /* Narrow panes keep the words and drop the icons: six short labels
         fit a sidebar, and the strip scrolls if they ever do not. */
      .settings-page-button::part(base) {
        padding: 0 var(--wa-space-2xs);
      }

      .settings-page-button::part(start) {
        display: none;
      }

      .settings-panel {
        padding: var(--wa-space-xs);
      }

      .settings-page-header {
        padding-bottom: var(--wa-space-xs);
      }
    }
  `,
];
