/** Component-scoped styles for {@link UserQuestionPanel} (user question requests). */

import { css, type CSSResult } from 'lit';

import { sp, visuallyHiddenDeclarations } from '@shared/styles';

export const userQuestionPanelStyles: CSSResult = css`
  .user-question-request__questions {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  .user-question-request__question {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    min-inline-size: 0;
    margin: 0;
    padding: ${sp.medium};
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-lowered);
  }

  .user-question-request__heading {
    max-inline-size: 100%;
    padding: 0;
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-normal);
    overflow-wrap: anywhere;
  }

  .user-question-request__heading-content {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: ${sp.small};
    max-inline-size: 100%;
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

  /* wa-radio-group has no exposed "radios" CSS part in the pinned
     @awesome.me/webawesome build (only form-control/form-control-label/
     form-control-input/hint are rendered) — style the host directly, same
     technique used for any themed wa-radio-group. */
  wa-radio-group {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  /* Web Awesome requires its label API to name the internal radio group. Keep
     the short action cue available to assistive technology without repeating
     the question already supplied by the outer fieldset legend. */
  wa-radio-group::part(form-control-label) {
    ${visuallyHiddenDeclarations}
  }

  .user-question-request__option {
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    color: var(--wa-color-text-normal);
  }

  .user-question-request__option::part(label) {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .user-question-request__option small {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-xs);
  }

  .user-question-request__free-text {
    min-inline-size: 0;
  }

  .user-question-request__answer-requirement {
    min-height: calc(var(--font-size-xs) * var(--line-height-normal));
    margin: 0;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-xs);
    line-height: var(--line-height-normal);
  }
`;
