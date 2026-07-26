// Third-party imports
import { css, type CSSResult } from 'lit';

// Shared history/search styles — use native Lit array instead of unsafeCSS embedding
import { searchStyles, historyListStyles } from '@shared/styles';

const settingsContainerStyles: CSSResult = css`
  :host {
    display: block;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .settings-container {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    /* A settings pane can be a quarter of a desktop grid, so navigation adapts
       to its container rather than the viewport. */
    container: settings / inline-size;
  }

  wa-tab-group.settings-tabs {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    /* The active tab is a filled pill rather than a thin edge indicator. */
    --track-color: transparent;
    --indicator-color: transparent;
  }

  /* WA's internal .tab-group wrapper (exposed as ::part(base)) is a flex
     column but doesn't inherit the bounded host height. Without height
     100% it sizes to content and the panel grows past the dialog viewport,
     defeating overflow:auto on the panel. */
  wa-tab-group.settings-tabs::part(base) {
    min-width: 0;
    height: 100%;
    min-height: 0;
  }

  wa-tab-group.settings-tabs::part(body) {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  wa-tab-group.settings-tabs::part(nav) {
    width: 100%;
    border-bottom: var(--border-thin) solid var(--border-hairline);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-lowered) 86%,
      var(--wa-color-surface-default)
    );
  }

  wa-tab-group.settings-tabs::part(tabs) {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    width: max-content;
    min-width: 100%;
    gap: var(--wa-space-3xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
  }

  wa-tab-group.settings-tabs wa-tab {
    flex: 0 0 auto;
    letter-spacing: var(--letter-spacing-tight);
    white-space: nowrap;
  }

  /* Tabs use the shared compact-control geometry so icon, label, and pointer
     target stay aligned at every pane width. */
  wa-tab-group.settings-tabs wa-tab::part(base) {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--height-control);
    padding: 0 var(--wa-space-xs);
    border: var(--border-thin) solid transparent;
    border-radius: var(--wa-border-radius-pill);
    font-size: var(--font-size);
    font-weight: var(--font-weight);
    color: var(--wa-color-text-quiet);
    transition:
      background-color var(--transition-fast),
      border-color var(--transition-fast),
      color var(--transition-fast);
  }

  wa-tab-group.settings-tabs wa-tab:hover::part(base) {
    background: var(--surface-hover);
  }

  wa-tab-group.settings-tabs wa-tab[active]::part(base) {
    border-color: var(--border-hairline);
    background: var(--wa-color-surface-default);
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
    box-shadow: var(--wa-shadow-s, none);
  }

  /* Group heading. Slotted into "nav" but not a wa-tab, so WA's getAllTabs()
     filter keeps it out of tab logic and arrow-key navigation. */
  .settings-nav-group {
    flex: 0 0 auto;
    align-self: center;
    margin-inline-start: var(--wa-space-2xs);
    padding-inline: var(--wa-space-xs) var(--wa-space-2xs);
    border-inline-start: var(--border-thin) solid var(--border-hairline);
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-medium);
    letter-spacing: 0.04em;
    line-height: var(--line-height-tight);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .settings-nav-group:first-of-type {
    margin-inline-start: 0;
    padding-inline-start: 0;
    border-inline-start: 0;
  }

  /* Group captions are supporting context. Drop them before squeezing the
     actual destinations, while keeping the tab labels available. */
  @container settings (max-width: 900px) {
    .settings-nav-group {
      display: none;
    }
  }

  /* Very narrow split panes retain all destinations as icon-only Web Awesome
     tabs. Every tab has an aria-label and title, so the compact rendering does
     not remove its name. */
  @container settings (max-width: 520px) {
    wa-tab-group.settings-tabs::part(tabs) {
      gap: var(--wa-space-3xs);
      padding-inline: var(--wa-space-2xs);
    }

    wa-tab-group.settings-tabs wa-tab {
      width: var(--height-control);
      height: var(--height-control);
    }

    wa-tab-group.settings-tabs wa-tab::part(base) {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 0;
    }

    wa-tab-group.settings-tabs wa-tab .settings-tab-label {
      display: none;
    }

    wa-tab .settings-tab-icon {
      margin-inline-end: 0;
    }
  }

  wa-tab-panel {
    flex: 1;
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    overflow: auto;
    --padding: var(--wa-space-s);
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

  .settings-unavailable-icon,
  .settings-tab-icon {
    display: grid;
    place-items: center;
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    line-height: 1;
  }

  wa-tab .settings-tab-icon {
    margin-inline-end: 0.45em;
    opacity: var(--opacity-normal);
  }

  wa-tab[active] .settings-tab-icon {
    opacity: 1;
  }
`;

/**
 * Combined settings view styles — array of shared + local styles.
 * Lit supports nested CSSResult arrays natively.
 */
export const settingsViewStyles = [
  searchStyles,
  historyListStyles,
  settingsContainerStyles,
];
