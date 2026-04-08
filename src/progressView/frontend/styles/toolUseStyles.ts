// Third-party imports
import { css } from 'lit';

/**
 * Tool-use section styles for scratchpad, tool calls, diffs, etc.
 */
export const toolUseStyles = css`
  .tool-use-section {
    margin: var(--spacing-small) 0;
    border-left: var(--border-medium) solid
      color-mix(in srgb, var(--vscode-textLink-foreground) 30%, transparent);
    padding-left: var(--spacing-medium);
  }

  .tool-use-title {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    user-select: text;
    cursor: text;
  }

  /* Allow selecting text in error/banner labels (overrides summary's user-select: none) */
  .details-summary .label {
    user-select: text;
    cursor: text;
  }

  .tool-use-label {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-link);
    margin-bottom: var(--spacing-small);
  }

  .tool-use-subsection {
    margin: var(--spacing-tiny) 0;
  }

  .tool-use-sublabel {
    font-weight: var(--font-weight-medium);
    color: var(--vscode-foreground);
    opacity: var(--opacity-normal);
    font-size: var(--font-size-sm);
  }

  .tool-use-separator {
    margin: var(--spacing-small) 0;
    border: none;
    border-top: var(--border-thin) solid var(--color-border);
    opacity: var(--opacity-separator);
  }

  :is(.tool-use-error, .banner-details--error)
    > .details-summary
    :is(.tool-use-title, .label, .codicon),
  .banner-content--error {
    color: var(--color-error);
  }

  .banner-content--error .error-details {
    margin: 0;
    padding: var(--spacing-small);
    background-color: var(
      --vscode-inputValidation-errorBackground,
      rgba(255, 0, 0, 0.1)
    );
    border-radius: var(--border-radius-small);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .banner-details--relay-error {
    position: relative;
  }

  .banner-details--relay-error::before {
    content: '';
    position: absolute;
    left: 0;
    inset-block: 0;
    width: var(--border-thick);
    background: var(--vscode-editorWarning-foreground, #ff8c00);
    border-radius: var(--border-radius-small) 0 0 var(--border-radius-small);
  }

  .banner-details--relay-error > .details-summary .label {
    color: var(--vscode-editorWarning-foreground, #ff8c00);
  }

  .tool-use-user-feedback > .details-summary :is(.tool-use-title, .codicon) {
    color: var(--vscode-textLink-foreground, #3794ff);
  }

  .tool-use-in-progress > .details-summary :is(.tool-use-title, .codicon) {
    color: var(--vscode-charts-yellow, #cca700);
  }

  /* Uses @keyframes spin from animationStyles (included via logStyles) */
  .tool-use-in-progress > .details-summary .codicon.spin {
    animation: spin 1s linear infinite;
  }

  .tool-use-in-progress > .details-summary tool-timer {
    color: var(--vscode-charts-yellow, #cca700);
  }

  :is(.tool-user-feedback, .tool-error-content, .tool-output-full) {
    white-space: pre-wrap;
    word-break: break-word;
  }

  :is(.tool-user-feedback, .tool-error-content) {
    padding: var(--spacing-small);
    border-radius: var(--border-radius-small);
    border-left: var(--border-thick) solid;
  }

  .tool-user-feedback {
    background-color: var(
      --vscode-inputValidation-infoBackground,
      rgba(55, 148, 255, 0.1)
    );
    border-left-color: var(--vscode-textLink-foreground, #3794ff);
  }

  .tool-error-content {
    background-color: var(
      --vscode-inputValidation-errorBackground,
      rgba(255, 0, 0, 0.1)
    );
    border-left-color: var(--color-error);
    color: var(--color-error);
  }

  .tool-output-full {
    max-height: var(--height-large);
    overflow: auto;
  }

  .tool-output-terminal {
    display: block;
    border-radius: var(--border-radius-small);
    overflow: hidden;
    background: var(--vscode-editor-background);
    border: var(--border-thin) solid var(--color-border);
  }

  /* Proposal setup link (in summary row and body) */
  .proposal-restore-link {
    color: var(--color-text-link);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-tiny);
    transition: color var(--transition-fast);
  }

  .proposal-restore-link:hover {
    text-decoration: underline;
  }

  .proposal-restore-link:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .proposal-banner-setup {
    margin-left: auto;
  }

  /* Follow-up break-wait button (shown inside executions wait entries) */
  .followup-break-wait {
    color: var(--color-text-link);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-tiny);
    margin-top: var(--spacing-small);
    padding: var(--spacing-tiny) var(--spacing-small);
    border: var(--border-thin) solid var(--color-text-link);
    border-radius: var(--border-radius-small);
    transition:
      color var(--transition-fast),
      background-color var(--transition-fast);
  }

  .followup-break-wait:hover {
    background-color: color-mix(
      in srgb,
      var(--color-text-link) 15%,
      transparent
    );
    text-decoration: none;
  }

  .followup-break-wait:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  /* Diff styles */
  .diff-add {
    color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
  }

  .diff-remove {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
  }

  .diff-hunk {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922);
  }

  .edit-diff-container {
    display: flex;
    flex-direction: column;
  }

  .diff-inline-view {
    margin: 0;
    padding: var(--spacing-small);
    border-radius: var(--border-radius-small);
    background-color: var(--vscode-editor-background);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: var(--line-height-relaxed);
  }

  :is(.diff-inline-del, .diff-inline-add) {
    border-radius: var(--border-radius);
    padding: var(--spacing-tiny) var(--spacing-small);
  }

  .diff-inline-del {
    background-color: var(
      --vscode-diffEditor-removedTextBackground,
      rgba(255, 0, 0, 0.2)
    );
    color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    text-decoration: line-through;
  }

  .diff-inline-add {
    background-color: var(
      --vscode-diffEditor-insertedTextBackground,
      rgba(0, 255, 0, 0.2)
    );
    color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
  }
`;
