// Third-party imports
import { css, type CSSResult } from 'lit';

export const historyViewStyles: CSSResult = css`
  .search-container {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    margin-bottom: var(--spacing-medium);
    padding: var(--spacing-small);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    background: var(--vscode-editor-background);
  }

  .search-input {
    flex: 1;
    width: 100%;
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

  .history-item:hover {
    background-color: var(--vscode-list-hoverBackground);
  }

  .history-item.selected {
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
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
    background-color: var(--vscode-editor-background);
    padding: var(--spacing-small);
    border-radius: var(--border-radius);
    margin-top: var(--spacing-small);
  }

  .config-item {
    display: flex;
    gap: var(--spacing-small);
  }

  .config-key {
    font-weight: 600;
    color: var(--vscode-editorInfo-foreground);
    min-width: 80px;
  }

  .config-value {
    color: var(--vscode-descriptionForeground);
    word-break: break-word;
  }

  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
  }

  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-tiny);
  }

  .agent-category-badge .codicon {
    font-size: 12px;
  }

  .category-workflow {
    background-color: var(--vscode-editorInfo-background);
    color: var(--vscode-editorInfo-foreground);
  }

  .category-tool-use {
    background-color: var(--vscode-editorWarning-background);
    color: var(--vscode-editorWarning-foreground);
  }

  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffd33d
    );
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    padding: 0 2px;
    border-radius: 2px;
  }

  mark.current-match {
    background-color: var(--vscode-editor-findMatchBackground, #ffdf5d);
    color: var(--vscode-editor-findMatchForeground, inherit);
    outline: 1px solid var(--vscode-editor-findMatchBorder, transparent);
  }
`;
