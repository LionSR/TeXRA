/**
 * Shared history/search styles used by HistoryTab and related components.
 */

import { css, type CSSResult } from 'lit';

/**
 * Search container and control styles.
 */
export const searchStyles: CSSResult = css`
  .search-container {
    display: flex;
    align-items: center;
    margin-bottom: var(--spacing-xlarge);
    gap: var(--spacing-medium);
    width: 100%;
  }

  .search-input {
    flex: 1;
    padding: var(--spacing-medium);
    font-size: var(--font-size);
  }

  .search-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    margin-left: auto;
  }

  .search-nav-btn {
    min-width: var(--height-button);
    height: var(--height-button);
    padding: 0;
    font-size: var(--font-size);
  }

  .match-count {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    min-width: calc(var(--height-button) * 2);
    text-align: center;
  }

  .history-clear-btn {
    color: var(--color-text-secondary);
    margin-left: var(--spacing-small);
  }

  .history-clear-btn::part(control) {
    border-radius: var(--border-radius-medium);
  }

  .history-clear-btn:hover {
    color: var(--color-removed);
  }
`;

/**
 * History list and item styles.
 */
export const historyListStyles: CSSResult = css`
  .history-container {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-medium);
  }

  .history-details {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: var(--spacing-small);
    margin-top: var(--spacing-medium);
  }

  .history-label {
    font-weight: var(--font-weight-bold);
    color: var(--texra-editor-foreground);
  }

  .history-value {
    color: var(--texra-editor-foreground);
    padding: var(--spacing-small) 0;
    word-break: break-word;
  }

  .history-item {
    margin-bottom: var(--spacing-medium);
  }

  .history-actions {
    display: flex;
    gap: var(--spacing-small);
  }

  .history-timestamp {
    font-size: var(--font-size-sm);
    margin-bottom: var(--spacing-small);
  }

  .history-description {
    font-size: var(--font-size-sm);
    color: var(--texra-descriptionForeground);
    font-style: italic;
    margin-top: var(--spacing-small);
    line-height: var(--line-height-normal);
  }

  .config-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small);
    background-color: var(--texra-editor-inactiveSelectionBackground);
    padding: var(--spacing-medium);
    border-radius: var(--border-radius);
    margin: var(--spacing-medium) 0;
  }

  .config-item {
    display: flex;
    gap: var(--spacing-medium);
    align-items: baseline;
  }

  .config-key {
    font-weight: var(--font-weight-medium);
    color: var(--texra-editorInfo-foreground);
    min-width: calc(
      var(--width-button-min) + var(--spacing-xlarge) + var(--spacing-xlarge)
    );
  }

  .config-value {
    color: var(--texra-descriptionForeground);
    word-break: break-word;
  }
`;

/**
 * Combined history styles array for easy import.
 */
export const historyStyles = [searchStyles, historyListStyles];
