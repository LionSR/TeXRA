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
    padding: var(--spacing-small) 0;
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

  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .agent-category-badge .codicon {
    font-size: var(--font-size-sm);
  }

  .category-workflow {
    background-color: var(
      --vscode-editorInfo-background,
      rgba(0, 127, 212, 0.15)
    );
    color: var(--vscode-editorInfo-foreground, #3794ff);
  }

  .category-tool-use {
    background-color: var(
      --vscode-editorWarning-background,
      rgba(255, 204, 0, 0.15)
    );
    color: var(--color-warning);
  }

  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffef0b80
    );
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    padding: 0;
    border-radius: var(--border-radius-small);
  }

  mark.current-match {
    background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }
`;
