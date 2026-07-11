/** Component-scoped styles for {@link UserQuestionPanel} (user question requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@shared/styles';

export const userQuestionPanelStyles: CSSResult = css`
  .user-question-request__context {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    padding: ${sp.small} ${sp.medium};
    background: var(--wa-color-surface-lowered);
    border-radius: var(--border-radius-small);
    line-height: var(--line-height-normal);
  }

  .user-question-request__questions {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  .user-question-request__question {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    padding: ${sp.medium};
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-lowered);
  }

  .user-question-request__heading {
    display: flex;
    align-items: baseline;
    gap: ${sp.small};
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-normal);
  }

  .user-question-request__header {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    flex: 0 0 auto;
  }

  .user-question-request__options {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .user-question-request__option {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: ${sp.small};
    align-items: start;
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    color: var(--wa-color-text-normal);
    cursor: pointer;
  }

  .user-question-request__option input {
    margin-top: 0.2rem;
  }

  .user-question-request__option span {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
  }

  .user-question-request__option small {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-xs);
  }

  .user-question-request__free-text {
    width: 100%;
  }
`;
