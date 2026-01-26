/**
 * Shared prompt overlay styles for Shadow DOM components.
 *
 * Provides enhanced styling for:
 * - Prompt cards with visual hierarchy
 * - Header with icon and title
 * - Body content formatting
 * - Action buttons (approve/reject/secondary)
 * - File paths and diff info
 * - Feedback forms
 *
 * Used by: PromptOverlay
 *
 * @example
 * import { promptOverlayStyles } from '@shared/styles/promptOverlayStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, promptOverlayStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const promptOverlayStyles: CSSResult = css`
  :host {
    display: block;
  }

  :host([hidden]) {
    display: none;
  }

  /* Card container with enhanced visual hierarchy */
  .prompt-card {
    border: 1px solid var(--vscode-input-border);
    border-radius: var(--border-radius-medium, 3px);
    background: var(--vscode-editor-background);
    margin-bottom: var(--spacing-medium, 8px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    overflow: hidden;
  }

  /* Header with accent color based on prompt type */
  .prompt-header {
    display: flex;
    align-items: center;
    gap: var(--spacing-small, 4px);
    padding: var(--spacing-small, 4px) var(--spacing-medium, 8px);
    font-weight: 600;
    font-size: var(--font-size, 13px);
    border-bottom: 1px solid var(--vscode-input-border);
    background: var(--vscode-sideBarSectionHeader-background, transparent);
  }

  .prompt-header .codicon {
    color: var(--vscode-terminal-ansiYellow);
    font-size: var(--font-size-icon, 16px);
  }

  /* Prompt type variants */
  .prompt-card[data-type='toolEdit'] .prompt-header {
    border-left: 3px solid
      var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
  }

  .prompt-card[data-type='bash'] .prompt-header {
    border-left: 3px solid var(--vscode-terminal-ansiGreen, #89d185);
  }

  .prompt-card[data-type='retry'] .prompt-header {
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
  }

  .prompt-card[data-type='proposal'] .prompt-header {
    border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
  }

  /* Body */
  .prompt-body {
    padding: var(--spacing-medium, 8px);
    font-size: var(--font-size, 13px);
    line-height: 1.5;
  }

  .prompt-body p {
    margin: 0 0 var(--spacing-small, 4px);
  }

  .prompt-body p:last-child {
    margin-bottom: 0;
  }

  .prompt-body strong {
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  /* Code block for commands */
  .code-block {
    display: block;
    padding: var(--spacing-medium, 8px);
    background: var(--vscode-textCodeBlock-background);
    border-radius: var(--border-radius, 3px);
    color: var(--vscode-terminal-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm, 12px);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    border-left: 3px solid var(--vscode-terminal-ansiGreen, #89d185);
  }

  /* Actions bar */
  .prompt-actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium, 8px);
    padding: var(--spacing-small, 4px) var(--spacing-medium, 8px);
    border-top: 1px solid var(--vscode-input-border);
    background: var(--vscode-sideBarSectionHeader-background, transparent);
  }

  .secondary-actions {
    margin-left: auto;
    display: flex;
    gap: var(--spacing-small, 4px);
  }

  /* Action buttons */
  .action-button {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-tiny, 2px);
    padding: var(--spacing-tiny, 2px) var(--spacing-small, 4px);
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    font-size: var(--font-size, 13px);
    cursor: pointer;
    border-radius: var(--border-radius, 3px);
    transition: all 0.15s ease;
  }

  .action-button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .action-button--approve {
    color: var(--vscode-testing-iconPassed, #89d185);
  }

  .action-button--approve:hover {
    background: rgba(137, 209, 133, 0.15);
    border-color: var(--vscode-testing-iconPassed, #89d185);
  }

  .action-button--reject {
    color: var(--vscode-testing-iconFailed, #f48771);
  }

  .action-button--reject:hover {
    background: rgba(244, 135, 113, 0.15);
    border-color: var(--vscode-testing-iconFailed, #f48771);
  }

  .action-button--secondary {
    color: var(--vscode-descriptionForeground);
  }

  .action-button--secondary:hover {
    color: var(--vscode-foreground);
  }

  /* File path styling */
  .file-path {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm, 12px);
    color: var(--color-text-link, var(--vscode-textLink-foreground));
    word-break: break-word;
    background: var(--vscode-textCodeBlock-background);
    padding: var(--spacing-tiny, 2px) var(--spacing-small, 4px);
    border-radius: var(--border-radius-small, 2px);
  }

  /* Diff info styling */
  .diff-info {
    display: inline-flex;
    align-items: baseline;
    gap: var(--spacing-small, 4px);
    font-size: var(--font-size-sm, 12px);
    font-family: var(--vscode-editor-font-family);
  }

  .diff-added {
    color: var(
      --color-added,
      var(--vscode-gitDecoration-addedResourceForeground, #89d185)
    );
    font-weight: 500;
  }

  .diff-removed {
    color: var(
      --color-removed,
      var(--vscode-gitDecoration-deletedResourceForeground, #f48771)
    );
    font-weight: 500;
  }

  .meta-text {
    color: var(--vscode-descriptionForeground);
    margin-left: var(--spacing-small, 4px);
  }

  /* File list styling */
  .file-list {
    margin: var(--spacing-tiny, 2px) 0;
  }

  .file-list-label {
    color: var(--vscode-descriptionForeground);
    margin-right: var(--spacing-tiny, 2px);
  }

  .file-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
  }

  .file-link:hover {
    text-decoration: underline;
  }

  /* Feedback section */
  .feedback-section {
    margin-top: var(--spacing-small, 4px);
    padding-top: var(--spacing-small, 4px);
    border-top: 1px dashed var(--vscode-input-border);
  }

  .feedback-label {
    display: block;
    margin-bottom: var(--spacing-tiny, 2px);
    font-size: var(--font-size-sm, 12px);
    color: var(--vscode-descriptionForeground);
  }

  .feedback-input {
    width: 100%;
    min-height: 60px;
    padding: var(--spacing-small, 4px);
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: var(--border-radius, 3px);
    font-family: inherit;
    font-size: var(--font-size-sm, 12px);
    resize: vertical;
    box-sizing: border-box;
  }

  .feedback-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }
`;
