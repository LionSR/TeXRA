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
    padding: var(--spacing-medium) var(--spacing-large);
    background: var(--vscode-sideBar-background);
    border-bottom: var(--border-thin) solid var(--color-border);
    margin-bottom: var(--spacing-medium);
  }

  .settings-header-user {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
  }

  .settings-header-user .codicon {
    font-size: var(--font-size-lg);
    opacity: var(--opacity-subtle);
  }

  .settings-header-info {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-tiny);
  }

  .settings-header-email {
    font-weight: 500;
    color: var(--vscode-foreground);
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
    gap: var(--spacing-small);
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
