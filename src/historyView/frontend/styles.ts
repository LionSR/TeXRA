// Third-party imports
import { css, type CSSResult } from 'lit';

// Shared badge/category styles are imported in HistoryApp.ts from @shared/styles
// This file contains only history-view-specific styles

export const historyViewStyles: CSSResult = css`
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

  .history-item:hover {
    background-color: var(--vscode-list-hoverBackground);
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

  .history-none {
    color: var(--color-text-secondary);
    font-style: italic;
  }

  /* Search highlight styles for mark.js */
  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffef0b80
    );
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    padding: 0;
    border-radius: var(--border-radius-small);
  }

  mark[data-current='true'] {
    background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }
`;
