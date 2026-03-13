import { css, type CSSResult } from 'lit';

export const permissionCardStyles: CSSResult = css`
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
    backdrop-filter: blur(4px);
  }

  :host([hidden]) {
    display: none;
  }

  .permission-card {
    background: var(--vscode-editor-background);
    border: var(--border-thin) solid var(--vscode-panel-border);
    border-radius: var(--border-radius-large);
    padding: var(--spacing-xlarge);
    max-width: 600px;
    width: min(92vw, 600px);
    box-shadow: 0 6px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }

  .permission-header {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    font-weight: var(--font-weight-semibold);
    margin-bottom: var(--spacing-medium);
  }

  .permission-body {
    font-size: var(--font-size);
    line-height: var(--line-height-relaxed);
    max-height: 50vh;
    overflow-y: auto;
  }

  .code-block {
    display: block;
    padding: var(--spacing-medium);
    background: var(--vscode-textCodeBlock-background);
    border-radius: var(--border-radius);
    color: var(--vscode-terminal-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .permission-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-medium);
    margin-top: var(--spacing-xlarge);
    justify-content: flex-end;
  }

  .secondary-actions,
  .primary-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-medium);
  }

  .primary-actions {
    margin-left: auto;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
    padding: var(--spacing-small) var(--spacing-medium);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: var(--border-thin) solid var(--vscode-button-border, transparent);
    border-radius: var(--border-radius);
    cursor: pointer;
    font-size: var(--font-size);
    transition:
      background-color var(--transition-fast),
      opacity var(--transition-fast);
  }

  .action-button:active {
    opacity: var(--opacity-normal);
  }

  .action-button:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .action-button--secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, inherit);
  }

  .file-path {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm);
    color: var(--vscode-textLink-foreground);
    word-break: break-word;
  }

  .diff-info {
    display: inline-flex;
    align-items: baseline;
    gap: var(--spacing-small);
    font-size: var(--font-size-sm);
    font-family: var(--vscode-editor-font-family);
  }

  .diff-added {
    color: var(--vscode-gitDecoration-addedResourceForeground, #89d185);
    font-weight: var(--font-weight-medium);
  }

  .diff-removed {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771);
    font-weight: var(--font-weight-medium);
  }

  .meta-text {
    color: var(--vscode-descriptionForeground);
    margin-left: var(--spacing-small);
  }

  .file-list {
    margin: var(--spacing-small) 0;
  }

  .file-list-label {
    color: var(--vscode-descriptionForeground);
    margin-right: var(--spacing-small);
  }

  .file-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .file-link:hover {
    text-decoration: underline;
  }

  .file-link:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .plan-steps-list {
    margin: var(--spacing-small) 0;
    padding-left: var(--spacing-xlarge);
  }

  .plan-steps-list li {
    margin-bottom: var(--spacing-small);
  }

  .feedback-section {
    margin-top: var(--spacing-large);
  }

  .feedback-label {
    display: block;
    margin-bottom: var(--spacing-small);
    font-size: var(--font-size-sm);
    color: var(--vscode-descriptionForeground);
  }

  .feedback-input {
    width: 100%;
    min-height: 60px;
    padding: var(--spacing-medium);
    border: var(--border-thin) solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: var(--border-radius);
    font-family: inherit;
    font-size: var(--font-size);
    resize: vertical;
    box-sizing: border-box;
  }

  .feedback-input:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }
`;
