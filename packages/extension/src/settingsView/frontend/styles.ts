// Third-party imports
import { css, type CSSResult } from 'lit';

// Shared history/search styles — use native Lit array instead of unsafeCSS embedding
import { searchStyles, historyListStyles } from '@shared/styles';

const settingsHeaderStyles: CSSResult = css`
  /* Settings header bar */
  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--wa-space-xs) var(--wa-space-s);
    background: var(--wa-color-surface-lowered);
    border-bottom: var(--border-thin) solid var(--color-border);
    margin-bottom: var(--wa-space-xs);
  }

  .settings-header-user {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
  }

  .settings-header-user-icon {
    display: block;
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    font-size: var(--font-size-icon);
    line-height: var(--line-height-tight);
    opacity: var(--opacity-subtle);
  }

  .settings-header-info {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-3xs);
  }

  .settings-header-email {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
  }

  .settings-header-tier {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .settings-header-signed-out {
    color: var(--color-text-secondary);
  }

  .settings-header-actions {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .settings-header-auth-button {
    flex-shrink: 0;
  }

  .settings-header-auth-button::part(base) {
    min-height: var(--height-control);
  }
`;

const settingsContainerStyles: CSSResult = css`
  :host {
    display: block;
    height: 100%;
  }

  .settings-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    /* A settings pane can be a quarter of a 2x2 desktop grid, so the nav
       collapses against the container, not the viewport. */
    container: settings / inline-size;
  }

  wa-tab-group.settings-tabs {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* placement="start": no vertical rule beside the nav, and the active row
       is a filled row rather than an edge indicator. */
    --track-color: transparent;
    --indicator-color: transparent;
  }

  /* WA's internal .tab-group wrapper (exposed as ::part(base)) is a flex
     column but doesn't inherit the bounded host height. Without height
     100% it sizes to content and the panel beside it grows past the dialog
     viewport, defeating overflow:auto on the panel. Still required with
     placement="start" — the wrapper is then a flex row, but the height
     inheritance problem is the same. */
  wa-tab-group.settings-tabs::part(base) {
    height: 100%;
    min-height: 0;
  }

  wa-tab-group.settings-tabs::part(body) {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  wa-tab-group.settings-tabs::part(nav) {
    width: var(--settings-nav-width, 220px);
    overflow-y: auto;
  }

  wa-tab-group.settings-tabs::part(tabs) {
    padding: var(--wa-space-2xs);
    gap: 1px;
  }

  wa-tab-group.settings-tabs wa-tab {
    letter-spacing: var(--letter-spacing-tight, -0.005em);
  }

  /* State overlays and row geometry come from the shared token layer. The
     fallbacks derive from the host's own text colour so hover/selected stay
     correct in both themes on a host that hasn't adopted the tokens yet. */
  wa-tab-group.settings-tabs wa-tab::part(base) {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    min-height: var(--row-height, 36px);
    padding: var(--row-padding, 6px 10px);
    border-radius: var(--row-radius, var(--wa-border-radius-m));
    font-size: var(--font-size);
    font-weight: var(--font-weight);
    color: var(--wa-color-text-quiet);
    transition: background-color var(--transition-fast);
  }

  wa-tab-group.settings-tabs wa-tab:hover::part(base) {
    background: var(
      --surface-hover,
      color-mix(in srgb, var(--wa-color-text-normal) 7%, transparent)
    );
  }

  wa-tab-group.settings-tabs wa-tab[active]::part(base) {
    background: var(
      --surface-selected,
      color-mix(in srgb, var(--wa-color-text-normal) 9%, transparent)
    );
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
  }

  /* Group heading. Slotted into "nav" but not a wa-tab, so WA's getAllTabs()
     filter keeps it out of tab logic and arrow-key navigation. */
  .settings-nav-group {
    padding: var(--wa-space-m) 10px var(--wa-space-3xs);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-quiet);
  }

  .settings-nav-group:first-of-type {
    padding-top: var(--wa-space-2xs);
  }

  /* Icon-only nav: a quarter-pane is too narrow for labels, and truncating
     them loses the distinction between adjacent rows. */
  @container settings (max-width: 620px) {
    wa-tab-group.settings-tabs::part(nav) {
      width: 52px;
    }

    wa-tab-group.settings-tabs wa-tab::part(base) {
      justify-content: center;
    }

    wa-tab-group.settings-tabs wa-tab .settings-tab-label,
    .settings-nav-group {
      display: none;
    }

    wa-tab .settings-tab-icon {
      margin-inline-end: 0;
    }
  }

  wa-tab-panel {
    flex: 1;
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
    display: block;
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    line-height: var(--line-height-tight);
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
  settingsHeaderStyles,
  settingsContainerStyles,
];
