/** Component-scoped styles for {@link RetryRequestPanel} (retry requests). */

import { css, type CSSResult } from 'lit';

export const retryRequestPanelStyles: CSSResult = css`
  /* No local clip. A max-height of 4em with overflow hidden cut the message
     with no way to read the rest: the adjacent "Error details" disclosure
     holds the failure's details, a different value, not the truncated remainder. The
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

  .retry-request__error-body {
    margin: 0;
    padding: 0 var(--wa-space-2xs) var(--wa-space-2xs);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
  }
`;
