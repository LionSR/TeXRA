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
  }

  .settings-header-auth-button {
    flex-shrink: 0;
  }

  .settings-header-auth-button::part(base) {
    min-height: var(--height-control);
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
];
