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

    /* The current page's sections: a second strip of text sub-tabs, on the
       page's own surface so it reads as part of the page below it. */
    .settings-section-nav {
      border-top: var(--border-thin) solid var(--border-hairline);
      background: var(--wa-color-surface-default);
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
      container: settings / inline-size;
      flex: 1;
      box-sizing: border-box;
      min-width: 0;
      min-height: 0;
      max-width: 100%;
      padding: var(--wa-space-m);
      overflow: auto;
      overscroll-behavior: contain;
    }

    .settings-page-header {
      margin-bottom: var(--wa-space-m);
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
      margin: var(--wa-space-2xs) 0 0;
      color: var(--wa-color-text-quiet);
      font-size: var(--font-size-sm);
      line-height: var(--line-height-normal);
      max-width: 65ch;
      text-wrap: pretty;
    }

    /* Desktop settings have enough room for a persistent section rail.
       Keeping the categories in one column leaves a stable reading edge. */
    :host([data-desktop-view]) .settings-container {
      display: grid;
      grid-template-columns: clamp(136px, 20%, 196px) minmax(0, 1fr);
    }

    :host([data-desktop-view]) .settings-navigation {
      min-height: 0;
      padding: var(--wa-space-xs);
      overflow-y: auto;
      overscroll-behavior: contain;
      border-bottom: 0;
      border-inline-end: var(--border-thin) solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-lowered);
    }

    :host([data-desktop-view]) .settings-page-nav {
      flex-direction: column;
      align-items: stretch;
      gap: var(--wa-space-3xs);
      padding: 0;
      overflow: visible;
    }

    :host([data-desktop-view]) .settings-section-nav {
      margin-top: var(--wa-space-m);
      padding-top: var(--wa-space-m);
      background: transparent;
    }

    :host([data-desktop-view]) .settings-page-button::part(base) {
      justify-content: flex-start;
      min-height: var(--height-button);
      padding-inline: var(--wa-space-xs);
      border-radius: var(--row-radius);
      box-shadow: none;
      white-space: normal;
      text-align: start;
    }

    :host([data-desktop-view])
      .settings-page-button[data-active='true']::part(base) {
      background: var(--surface-selected);
      color: var(--wa-color-brand-on-quiet);
      font-weight: var(--font-weight-semibold);
    }

    :host([data-desktop-view]) .settings-section-button::part(base) {
      min-height: var(--height-control-compact);
      font-size: var(--font-size-xs);
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
