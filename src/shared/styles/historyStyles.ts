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

  .clear-container {
    margin-bottom: var(--spacing-xlarge);
  }

  .button-clear {
    padding: var(--spacing-medium) var(--spacing-large);
  }

  .history-details {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: var(--spacing-small);
    margin-top: var(--spacing-medium);
  }

  .history-label {
    font-weight: bold;
    color: var(--vscode-editor-foreground);
  }

  .history-value {
    color: var(--vscode-editor-foreground);
    padding: var(--spacing-small) 0;
    word-break: break-word;
  }

  .history-item.selected {
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
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

  .config-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small);
    background-color: var(--vscode-editor-inactiveSelectionBackground);
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
    font-weight: 500;
    color: var(--vscode-editorInfo-foreground);
    min-width: calc(
      var(--width-button-min) + var(--spacing-xlarge) + var(--spacing-xlarge)
    );
  }

  .config-value {
    color: var(--vscode-descriptionForeground);
    word-break: break-word;
  }
`;

/**
 * Combined history styles array for easy import.
 */
export const historyStyles = [searchStyles, historyListStyles];
