// Third-party imports
import { css } from 'lit';

/**
 * Tool-use section styles for scratchpad, tool calls, diffs, etc.
 */
export const toolUseStyles = css`
  .tool-use-section {
    margin: var(--wa-space-2xs) 0;
    border-left: var(--border-medium) solid
      color-mix(in srgb, var(--wa-color-text-link) 30%, transparent);
    padding-left: var(--wa-space-xs);
  }

  .tool-use-title {
    flex: 1;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
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
    margin-bottom: var(--wa-space-2xs);
  }

  .tool-use-subsection {
    margin: var(--wa-space-3xs) 0;
  }

  .tool-use-sublabel {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
    opacity: var(--opacity-normal);
    font-size: var(--font-size-sm);
  }

  .tool-use-separator {
    margin: var(--wa-space-2xs) 0;
    border: none;
    border-top: var(--border-thin) solid var(--color-border);
    opacity: var(--opacity-separator);
  }

  :is(.tool-use-error, .banner-details--error)
    > .details-summary
    :is(.tool-use-title, .label, wa-icon),
  .banner-content--error {
    color: var(--color-error);
  }

  .banner-content--error .error-details {
    margin: 0;
    padding: var(--wa-space-2xs);
    background-color: var(
      --texra-inputValidation-errorBackground,
      rgba(255, 0, 0, 0.1)
    );
    border-radius: var(--border-radius-small);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .banner-details--relay-error {
    border-left: var(--border-medium) solid
      var(--wa-color-warning-on-quiet, #ff8c00);
    border-radius: 0 var(--border-radius-small) var(--border-radius-small) 0;
  }

  .banner-details--relay-error > .details-summary .label {
    color: var(--wa-color-warning-on-quiet, #ff8c00);
  }

  .tool-use-user-feedback > .details-summary :is(.tool-use-title, wa-icon) {
    color: var(--wa-color-text-link, #3794ff);
  }

  .tool-use-in-progress > .details-summary :is(.tool-use-title, wa-icon),
  .tool-use-in-progress > .details-summary wa-spinner {
    color: var(--wa-color-chart-yellow, #cca700);
  }

  .tool-use-in-progress > .details-summary tool-timer {
    color: var(--wa-color-chart-yellow, #cca700);
  }

  :is(.tool-user-feedback, .tool-error-content, .tool-output-full) {
    white-space: pre-wrap;
    word-break: break-word;
  }

  :is(.tool-user-feedback, .tool-error-content) {
    padding: var(--wa-space-2xs);
    border-radius: var(--border-radius-small);
    border-left: var(--border-medium) solid;
  }

  .tool-user-feedback {
    background-color: var(--wa-color-brand-fill-quiet, rgba(55, 148, 255, 0.1));
    border-left-color: var(--wa-color-text-link, #3794ff);
  }

  .tool-error-content {
    background-color: var(
      --texra-inputValidation-errorBackground,
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
    background: var(--wa-color-surface-default);
    border: var(--border-thin) solid var(--color-border);
  }

  /* Proposal restore link */
  .proposal-restore-link {
    color: var(--color-text-link);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
  }

  .proposal-restore-link:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  /* Proposal setup link (in summary row and body) */
  .proposal-restore-link:hover {
    text-decoration: underline;
  }

  .proposal-banner-setup {
    margin-left: auto;
  }

  /* Diff styles */
  .diff-add {
    color: var(--wa-color-git-added, #3fb950);
  }

  .diff-remove {
    color: var(--wa-color-git-deleted, #f85149);
  }

  .diff-hunk {
    color: var(--wa-color-git-modified, #d29922);
  }

  .edit-diff-container {
    display: flex;
    flex-direction: column;
  }

  .diff-inline-view {
    margin: 0;
    padding: var(--wa-space-2xs);
    border-radius: var(--border-radius-small);
    background-color: var(--wa-color-surface-default);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: var(--line-height-relaxed);
  }

  :is(.diff-inline-del, .diff-inline-add) {
    border-radius: var(--border-radius);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
  }

  .diff-inline-del {
    background-color: var(--wa-color-diff-removed, rgba(255, 0, 0, 0.2));
    color: var(--wa-color-git-deleted, #f85149);
    text-decoration: line-through;
  }

  .diff-inline-add {
    background-color: var(--wa-color-diff-inserted, rgba(0, 255, 0, 0.2));
    color: var(--wa-color-git-added, #3fb950);
  }
`;
