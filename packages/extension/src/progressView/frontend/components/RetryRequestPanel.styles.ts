/** Component-scoped styles for {@link RetryRequestPanel} (retry requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@shared/styles';

export const retryRequestPanelStyles: CSSResult = css`
  .retry-request__operation {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
  }

  /* No local clip. A max-height of 4em with overflow hidden cut the message
     with no way to read the rest: the adjacent "Error details" disclosure
     holds errorDetails, a different value, not the truncated remainder. The
     text-overflow: ellipsis beside it never applied either — that needs
     white-space: nowrap or a line clamp, so the text was hard-cut without
     even an ellipsis to show it. Length is already handled one level up,
     where retry-request__details scrolls at min(34vh, 26rem).

     Sized with its sibling __operation rather than a step below it: this is
     the text explaining why the call failed, and it was the smallest text in
     the panel at 10.4px. */
  .retry-request__error {
    font-size: var(--font-size-sm);
    color: var(--color-error);
    word-break: break-word;
  }

  .retry-request__error-details {
    margin-top: ${sp.tiny};
    font-size: var(--font-size-xs);
  }

  .retry-request__error-details::part(header) {
    min-height: 28px;
    padding: ${sp.small} ${sp.large};
    color: var(--wa-color-text-quiet);
  }

  .retry-request__error-details::part(content) {
    padding: 0 ${sp.large} ${sp.large};
  }

  .retry-request__error-summary {
    cursor: pointer;
    color: var(--wa-color-text-quiet);
    display: flex;
    align-items: center;
    gap: ${sp.tiny};
    user-select: none;
  }

  .retry-request__error-summary:hover {
    color: var(--wa-color-text-normal);
  }

  .retry-request__error-body {
    margin-top: ${sp.tiny};
    padding: ${sp.small};
    background: var(--wa-color-surface-lowered);
    border-radius: var(--border-radius-small);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
  }
`;
