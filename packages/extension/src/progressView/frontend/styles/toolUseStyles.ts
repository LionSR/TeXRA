// Third-party imports
import { css } from 'lit';

/**
 * Tool-use section styles for scratchpad, tool calls, diffs, etc.
 */
export const toolUseStyles = css`
  .tool-use-section {
    margin: var(--wa-space-2xs) 0;
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

  .tool-use-sublabel {
    font-weight: var(--font-weight-medium);
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
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
    background-color: var(--wa-color-danger-fill-quiet);
    border-radius: var(--border-radius-small);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Hide <wa-details>'s built-in disclosure icon when there's nothing to
     expand (mirrors the old native-details toggle-icon visibility:hidden). */
  wa-details.banner-details--no-toggle::part(icon) {
    visibility: hidden;
  }

  .tool-use-user-feedback > .details-summary :is(.tool-use-title, wa-icon) {
    color: var(--color-text-link);
  }

  .tool-use-in-progress > .details-summary :is(.tool-use-title, wa-icon),
  .tool-use-in-progress > .details-summary :is(wa-spinner, tool-timer) {
    color: var(--color-pending);
  }

  :is(.tool-user-feedback, .tool-error-content, .tool-output-full) {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :is(.tool-user-feedback, .tool-error-content) {
    padding: var(--wa-space-2xs);
    border-radius: var(--border-radius-small);
    border-inline-start: var(--border-medium) solid;
  }

  .tool-user-feedback {
    background-color: var(--wa-color-brand-fill-quiet, rgba(55, 148, 255, 0.1));
    border-inline-start-color: var(--color-text-link);
  }

  .tool-error-content {
    background-color: var(--wa-color-danger-fill-quiet);
    border-inline-start-color: var(--color-error);
    color: var(--color-error);
  }

  .tool-output-full {
    max-height: var(--height-large);
    overflow: auto;
  }

  .tool-output-terminal {
    display: block;
    border-radius: var(--wa-border-radius-m, var(--border-radius-small));
    overflow: hidden;
    background: var(--wa-color-surface-default);
    border: var(--border-thin) solid var(--color-border);
  }

  wa-details.tool-use-details {
    margin-block: var(--wa-space-3xs);
  }

  wa-details.tool-use-details::part(base) {
    border: var(--border-thin) solid
      color-mix(in srgb, var(--wa-color-surface-border) 76%, transparent);
    border-radius: var(--wa-border-radius-m, var(--border-radius));
    background: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 44%,
      transparent
    );
  }

  wa-details.tool-use-details::part(header) {
    min-height: 28px;
    padding: var(--wa-space-3xs) var(--wa-space-xs);
  }

  wa-details.tool-use-details::part(content) {
    padding: 0 var(--wa-space-xs) var(--wa-space-xs);
  }

  /* Summary actions — real <button>s (not role="button" spans) so
   * wa-details' own summary click handler recognizes it as interactive and
   * skips its toggle; reset native button chrome to keep the prior
   * link-like appearance. */
  :is(.proposal-restore-link, .spill-artifact-link) {
    background: none;
    border: none;
    margin: 0;
    padding: 0;
    font: inherit;
    text-align: left;
    color: var(--color-text-link);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
  }

  /* Radius only — the ring comes from focusRingStyles. */
  :is(.proposal-restore-link, .spill-artifact-link):focus-visible {
    border-radius: var(--border-radius-small);
  }

  /* Summary actions (in summary row and body) */
  :is(.proposal-restore-link, .spill-artifact-link):hover {
    text-decoration: underline;
  }

  .proposal-banner-setup {
    margin-inline-start: auto;
  }

  /* Diff styles */
  .diff-add {
    color: var(--color-diff-added);
  }

  .diff-remove {
    color: var(--color-diff-removed);
  }

  .diff-hunk {
    color: var(--color-diff-modified);
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
    color: var(--color-diff-removed);
    text-decoration: line-through;
  }

  .diff-inline-add {
    background-color: var(--wa-color-diff-inserted, rgba(0, 255, 0, 0.2));
    color: var(--color-diff-added);
  }
`;
