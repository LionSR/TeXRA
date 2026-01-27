/**
 * Shared prompt overlay styles for Shadow DOM components.
 *
 * Provides overlay styling for:
 * - Centered prompt card with dimmed backdrop
 * - Header, body, and action layout
 * - Action buttons (primary/secondary)
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
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    background: color-mix(
      in srgb,
      var(--vscode-editor-background) 60%,
      transparent
    );
  }

  :host([hidden]) {
    display: none;
  }

  .prompt-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 16px;
    max-width: 600px;
    width: min(92vw, 600px);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }

  .prompt-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    margin-bottom: 8px;
  }

  .prompt-body {
    font-size: 13px;
    line-height: 1.5;
  }

  .code-block {
    display: block;
    padding: 8px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px;
    color: var(--vscode-terminal-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .prompt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
    justify-content: flex-end;
  }

  .secondary-actions,
  .primary-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .primary-actions {
    margin-left: auto;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .action-button--secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit);
  }

  .file-path {
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    color: var(--vscode-textLink-foreground);
    word-break: break-word;
  }

  .diff-info {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family);
  }

  .diff-added {
    color: var(--vscode-gitDecoration-addedResourceForeground, #89d185);
    font-weight: 500;
  }

  .diff-removed {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771);
    font-weight: 500;
  }

  .meta-text {
    color: var(--vscode-descriptionForeground);
    margin-left: 4px;
  }

  .file-list {
    margin: 4px 0;
  }

  .file-list-label {
    color: var(--vscode-descriptionForeground);
    margin-right: 4px;
  }

  .file-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
  }

  .file-link:hover {
    text-decoration: underline;
  }

  .feedback-section {
    margin-top: 12px;
  }

  .feedback-label {
    display: block;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .feedback-input {
    width: 100%;
    min-height: 60px;
    padding: 8px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 4px;
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    box-sizing: border-box;
  }

  .feedback-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }
`;
