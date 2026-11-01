/** Component-scoped styles for {@link RetryRequestPanel} (retry requests). */

import { css, type CSSResult } from 'lit';

export const retryRequestPanelStyles: CSSResult = css`
  /* No local clip. A max-height of 4em with overflow hidden cut the message
     with no way to read the rest: the adjacent "Error details" disclosure
     holds errorDetails, a different value, not the truncated remainder. The
     text-overflow: ellipsis beside it never applied either — that needs
     white-space: nowrap or a line clamp, so the text was hard-cut without
     even an ellipsis to show it. Length is already handled one level up,
     where the card's details scroll.

     Body size rather than a step below it: this is the text explaining why
     the call failed. */
  .retry-request__error {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-normal);
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }

  .retry-request__error-details {
    --spacing: 0;
    margin: 0;
    font-size: var(--font-size-xs);
  }

  .retry-request__error-details::part(header) {
    min-height: var(--height-control-compact);
    padding: 0;
    box-sizing: border-box;
    color: var(--wa-color-text-quiet);
  }

  .retry-request__error-details::part(content) {
    padding: 0;
  }

  .retry-request__error-summary {
    cursor: pointer;
    color: var(--wa-color-text-quiet);
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    user-select: none;
  }

  .retry-request__error-summary:hover {
    color: var(--wa-color-text-normal);
  }

  .retry-request__error-body {
    margin: 0;
    padding: var(--wa-space-2xs) 0;
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
  }
`;
