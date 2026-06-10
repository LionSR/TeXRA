// Third-party imports
import { css, type CSSResult } from 'lit';

// Shared history/search styles — use native Lit array instead of unsafeCSS embedding
import {
  searchStyles,
  historyListStyles,
  waTabThemeTokenStyles,
} from '@shared/styles';

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
    width: var(--font-size-lg);
    height: var(--font-size-lg);
    flex: 0 0 auto;
    font-size: var(--font-size-lg);
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
    margin-right: calc(var(--wa-space-s) + var(--height-control));
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
  }

  wa-tab-group.settings-tabs {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    ${waTabThemeTokenStyles}
  }

  /* WA's internal .tab-group wrapper (exposed as ::part(base)) is a flex
     column but doesn't inherit the bounded host height. Without height
     100% it sizes to content and the panel below grows past the dialog
     viewport, defeating overflow:auto on the panel. */
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

  /*
   * Settings has 8 tabs — the strip needs a touch more breathing
   * room for icon+label rows than the inline view-tabs. The shared
   * waTabThemeTokenStyles sets the indicator weight + colour;
   * here we tune density + the active-state polish for this surface.
   */
  wa-tab-group.settings-tabs::part(nav) {
    padding-inline: var(--wa-space-2xs);
    gap: 1px;
  }

  wa-tab-group.settings-tabs wa-tab {
    font-size: var(--font-size-sm);
    letter-spacing: -0.005em;
  }

  wa-tab-group.settings-tabs wa-tab::part(base) {
    padding-block: 6px;
    padding-inline: var(--wa-space-s);
    color: color-mix(in srgb, var(--wa-color-text-normal) 65%, transparent);
    border-radius: var(--wa-border-radius-s, 4px) var(--wa-border-radius-s, 4px)
      0 0;
  }

  wa-tab-group.settings-tabs wa-tab[active]::part(base) {
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold, 600);
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
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
  }

  wa-tab .settings-tab-icon {
    margin-inline-end: 0.45em;
    opacity: var(--opacity-normal);
  }

  wa-tab[active] .settings-tab-icon {
    opacity: 1;
    color: var(--wa-color-brand-fill-loud);
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
