// Third-party imports
import { css } from 'lit';
import { messageHeaderStyles } from '@ui/styles/messageHeaderStyles';
import {
  panelFrameStyles,
  panelHeaderStyles,
  panelContentStyles,
} from '@ui/styles/surfaceStyles';

/**
 * Tool-use section styles for scratchpad, tool calls, diffs, etc.
 */
export const toolUseStyles = css`
  ${messageHeaderStyles}
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

  /* Single-line facts the model carries beside the output block. */
  .tool-exit-code {
    color: var(--color-error);
    font-size: var(--font-size-sm);
  }

  .tool-no-output {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  :is(.tool-use-error, .banner-details--error) > .details-summary > wa-icon {
    color: var(--color-error);
  }

  .banner-details--error .label {
    flex: 1;
    min-width: 0;
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  wa-details:is(.banner-details--error, .banner-details--assistant)::part(
      summary
    ) {
    width: 100%;
    min-width: 0;
  }

  :is(.banner-details--error, .banner-details--assistant) > .details-summary {
    --message-actions-width: var(--control-size-s);
    width: 100%;
    padding: 0;
  }

  .banner-details--error .message-label > .icon {
    color: var(--color-error);
  }

  wa-details.banner-details--error::part(base) {
    ${panelFrameStyles}
  }

  wa-details:is(.banner-details--error, .banner-details--assistant)::part(
      header
    ) {
    ${panelHeaderStyles}
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--control-size-s);
    gap: var(--wa-space-xs);
  }

  wa-details:is(.banner-details--error, .banner-details--assistant)::part(
      icon
    ) {
    display: grid;
    place-items: center;
    width: var(--control-size-s);
    height: var(--control-size-s);
    margin: 0;
  }

  wa-details:is(.banner-details--error, .banner-details--assistant)::part(
      content
    ) {
    ${panelContentStyles}
  }

  .banner-content--error {
    padding: 0;
  }

  .banner-details--assistant {
    margin-block-end: var(--message-gap);
  }

  .banner-details--assistant::part(base) {
    border: var(--border-thin) solid transparent;
  }

  .banner-details--assistant .banner-content {
    padding: 0;
  }

  .banner-content--error .error-details {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--wa-color-text-quiet);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-use-user-feedback > .details-summary :is(.tool-use-title, wa-icon) {
    color: var(--color-text-link);
  }

  .tool-use-in-progress > .details-summary :is(.tool-use-title, wa-icon),
  .tool-use-in-progress > .details-summary :is(wa-spinner, tool-timer) {
    color: var(--color-pending);
  }

  /* An open call on an interrupted run: stopped, waiting for Resume. */
  .tool-use-interrupted > .details-summary :is(wa-icon, .tool-interrupted) {
    color: var(--color-warning);
  }

  .tool-interrupted {
    font-size: var(--font-size-sm);
    margin-inline-start: var(--wa-space-xs);
  }

  :is(.tool-user-feedback, .tool-error-content, .tool-output-full) {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :is(.tool-user-feedback, .tool-error-content) {
    ${panelFrameStyles}
    padding: var(--panel-padding-block) var(--panel-padding-inline);
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

  wa-details.tool-use-details {
    margin-block: var(--wa-space-3xs);
  }

  wa-details.tool-use-details::part(base) {
    ${panelFrameStyles}
  }

  wa-details.tool-use-details::part(header) {
    ${panelHeaderStyles}
  }

  wa-details.tool-use-details::part(content) {
    ${panelContentStyles}
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
