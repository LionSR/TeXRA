// Third-party imports
import { css } from 'lit';

/**
 * Tool-use section styles for scratchpad, tool calls, diffs, etc.
 */
export const toolUseStyles = css`
  .tool-use-section {
    margin: var(--spacing-small) 0;
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

  .tool-use-label {
    font-weight: 600;
    color: var(--color-text-link);
    margin-bottom: var(--spacing-small);
  }

  .tool-use-subsection {
    margin: var(--spacing-tiny) 0;
  }

  .tool-use-sublabel {
    font-weight: 500;
    color: var(--vscode-foreground);
    opacity: 0.8;
    font-size: var(--font-size-sm);
  }

  .tool-use-separator {
    margin: var(--spacing-small) 0;
    border: none;
    border-top: var(--border-thin) solid var(--color-border);
    opacity: 0.3;
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
    width: 3px;
    background: var(--vscode-editorWarning-foreground, #ff8c00);
    border-radius: var(--border-radius-small) 0 0 var(--border-radius-small);
  }

  .banner-details--relay-error > .details-summary .label {
    color: var(--vscode-editorWarning-foreground, #ff8c00);
  }

  .tool-use-user-feedback > .details-summary .tool-use-title,
  .tool-use-user-feedback > .details-summary .codicon {
    color: var(--vscode-textLink-foreground, #3794ff);
  }

  :is(.tool-user-feedback, .tool-error-content, .tool-output-full) {
    white-space: pre-wrap;
    word-break: break-word;
  }

  :is(.tool-user-feedback, .tool-error-content) {
    padding: var(--spacing-small);
    border-radius: var(--border-radius-small);
    border-left: 3px solid;
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
  }

  .tool-output-full {
    max-height: var(--height-large);
    overflow: auto;
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
    background-color: var(--vscode-editor-background, #1e1e1e);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  :is(.diff-inline-del, .diff-inline-add) {
    border-radius: 2px;
    padding: 0 2px;
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
