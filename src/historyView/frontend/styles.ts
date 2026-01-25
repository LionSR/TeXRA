// Third-party imports
import { css, type CSSResult } from 'lit';

export const historyViewStyles: CSSResult = css`
  .search-container {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    margin-bottom: var(--spacing-medium);
  }

  .search-input {
    flex: 1;
  }

  .search-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .search-nav-btn {
    flex-shrink: 0;
  }

  .match-count {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    min-width: 40px;
    text-align: right;
  }

  .history-container {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-medium);
  }

  .clear-container {
    margin-bottom: var(--spacing-small);
  }

  .history-details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--spacing-small) var(--spacing-medium);
    margin-top: var(--spacing-small);
  }

  .history-label {
    font-weight: 600;
  }

  .history-value {
    word-break: break-word;
  }

  .history-actions {
    display: flex;
    gap: var(--spacing-small);
  }

  .history-timestamp {
    font-size: var(--font-size-sm);
  }

  .history-none {
    opacity: 0.8;
  }

  .config-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-tiny);
  }

  .config-item {
    display: flex;
    gap: var(--spacing-small);
  }

  .config-key {
    font-weight: 600;
  }

  .category-workflow {
    background-color: var(--vscode-charts-blue);
    color: var(--vscode-editor-background);
  }

  .category-tool-use {
    background-color: var(--vscode-charts-orange);
    color: var(--vscode-editor-background);
  }

  mark {
    background: var(--vscode-editor-findMatchBackground);
    color: inherit;
    padding: 0 2px;
  }

  mark.current-match {
    background: var(--vscode-editor-findMatchHighlightBackground);
  }
`;
