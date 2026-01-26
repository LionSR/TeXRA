// Third-party imports
import { css, type CSSResult } from 'lit';

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
    margin-bottom: var(--spacing-small);
  }

  .button-clear {
    margin-bottom: var(--spacing-small);
    padding: var(--spacing-tiny) var(--spacing-small);
  }

  .history-details {
    display: grid;
    grid-template-columns: var(--width-button-min, 100px) 1fr;
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

  .history-none {
    color: var(--color-text-secondary);
    font-style: italic;
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

  .badge {
    display: inline-block;
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    font-weight: 500;
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
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffef0b80
    );
    padding: 0;
    border-radius: var(--border-radius-small);
  }

  mark.current-match {
    background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }
`;
