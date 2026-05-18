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
    margin-bottom: var(--wa-space-l);
    gap: var(--wa-space-xs);
    width: 100%;
  }

  .search-input {
    flex: 1;
    padding: var(--wa-space-xs);
    font-size: var(--font-size);
  }

  .search-controls {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    margin-left: auto;
  }

  .match-count {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    min-width: calc(var(--height-button) * 2);
    text-align: center;
  }

  .action-icon-button[data-action='clear-history'] {
    color: var(--color-text-secondary);
    margin-left: var(--wa-space-2xs);
  }

  .action-icon-button[data-action='clear-history']::part(base) {
    border-radius: var(--border-radius-medium);
  }

  .action-icon-button[data-action='clear-history']:hover {
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
    gap: var(--wa-space-xs);
  }

  .history-details {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: var(--wa-space-2xs);
    margin-top: var(--wa-space-xs);
  }

  .history-label {
    font-weight: var(--font-weight-normal);
    color: var(--wa-color-text-quiet);
  }

  .history-value {
    color: var(--wa-color-text-normal);
    padding: var(--wa-space-2xs) 0;
    word-break: break-word;
  }

  .history-item {
    margin-bottom: var(--wa-space-xs);
  }

  .history-actions {
    display: flex;
    gap: var(--wa-space-2xs);
  }

  .history-timestamp {
    font-size: var(--font-size-sm);
    margin-bottom: var(--wa-space-2xs);
  }

  .history-description {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    font-style: italic;
    margin-top: var(--wa-space-2xs);
    line-height: var(--line-height-normal);
  }

  .history-item .collapsible::part(header) {
    font-weight: var(--font-weight-normal);
  }

  .history-title {
    flex: 1;
    min-width: 0;
    font-weight: var(--font-weight-normal);
    color: var(--wa-color-text-normal);
    word-break: break-word;
  }

  .history-title .markdown-content {
    font-weight: var(--font-weight-normal);
  }

  .config-section {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) 0;
  }

  .config-item {
    display: flex;
    gap: var(--wa-space-xs);
    align-items: baseline;
  }

  .config-key {
    font-weight: var(--font-weight-normal);
    color: var(--wa-color-text-quiet);
    min-width: calc(
      var(--width-button-min) + var(--wa-space-l) + var(--wa-space-l)
    );
  }

  .config-value {
    color: var(--wa-color-text-normal);
    word-break: break-word;
  }

  .config-value .markdown-content p {
    margin: 0;
  }
`;

/**
 * Combined history styles array for easy import.
 */
export const historyStyles = [searchStyles, historyListStyles];
