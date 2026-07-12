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

  .retry-request__error {
    font-size: var(--font-size-xs);
    color: var(--color-error);
    word-break: break-word;
    max-height: 4em;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .retry-request--relay .retry-request__operation {
    color: var(--color-warning);
  }
`;
