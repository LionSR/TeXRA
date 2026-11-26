// Third-party imports
import { css } from 'lit';
import {
  messageHeaderStyles,
  messageDisclosureStyles,
  messageMetaStyles,
} from '@ui/styles/messageHeaderStyles';
import { panelFrameStyles } from '@ui/styles/surfaceStyles';

/**
 * Tool-use section styles for tool calls, diffs, etc.
 */
export const toolUseStyles = css`
  ${messageHeaderStyles}
  ${messageDisclosureStyles}
  ${messageMetaStyles}
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
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  /* Single-line facts the model carries beside the output block. */
  .tool-exit-code {
    color: var(--color-error);
    font-size: var(--font-size-sm);
  }

  .tool-no-output {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  :is(.tool-use-error, .banner-details--error) > .details-summary > wa-icon {
    color: var(--tone-color);
  }

  .banner-details--error .label {
    flex: 1;
    min-width: 0;
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .banner-details--error .message-label > .icon {
    color: var(--tone-color);
  }

  wa-details.banner-details--error::part(base) {
    ${panelFrameStyles}
  }

  .banner-content--error {
    padding: 0;
  }

  /* An answer is its text on the page: no author line, no frame. */
  .assistant-message > .banner-content {
    padding: 0;
  }

  .banner-content--error .error-details {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--color-text-secondary);
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
    color: var(--tone-color);
  }

  /* An open call on an interrupted run: stopped, waiting for Resume. */
  .tool-use-interrupted > .details-summary :is(wa-icon, .tool-interrupted) {
    color: var(--tone-color);
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

  /* A tool call or a thought is one quiet line that opens in place: icon,
     what it did, what to. Consecutive lines sit close; the gap to a
     message is the transcript's. */
  wa-details.activity-row {
    margin: 0;
  }

  .activity-row + :not(.activity-row) {
    margin-block-start: var(--message-gap);
  }

  wa-details.activity-row::part(header) {
    flex-direction: row;
    justify-content: flex-start;
    gap: var(--wa-space-2xs);
    margin-inline: calc(-1 * var(--wa-space-xs));
    padding: 0 var(--wa-space-xs);
    border-radius: var(--field-radius);
  }

  wa-details.activity-row::part(header):hover {
    background: var(--surface-hover);
  }

  /* The chevron follows the line and shows once the row is pointed at,
     focused or open. */
  wa-details.activity-row::part(icon) {
    font-size: var(--font-size-xs);
    opacity: 0;
  }

  wa-details.activity-row:is([open], :hover, :focus-within)::part(icon) {
    opacity: var(--opacity-full);
  }

  @media (hover: none) {
    wa-details.activity-row::part(icon) {
      opacity: var(--opacity-full);
    }
  }

  wa-details.activity-row::part(content) {
    padding: var(--wa-space-3xs) 0 var(--wa-space-xs)
      calc(var(--font-size-icon-sm) + var(--wa-space-xs));
  }

  /* A spinner takes its icon's column, so running lines stay aligned. */
  .activity-row > .details-summary > .icon {
    flex: 0 0 var(--font-size-icon-sm);
    width: var(--font-size-icon-sm);
  }

  .summary-detail {
    color: var(--wa-color-text-normal);
  }

  .tool-use-in-progress .summary-detail {
    color: inherit;
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
    background-color: var(--wa-color-diff-removed);
    color: var(--color-diff-removed);
    text-decoration: line-through;
  }

  .diff-inline-add {
    background-color: var(--wa-color-diff-inserted);
    color: var(--color-diff-added);
  }
`;
