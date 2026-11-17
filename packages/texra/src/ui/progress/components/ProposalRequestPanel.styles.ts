/** Component-scoped styles for {@link ProposalRequestPanel} (script proposal requests). */

import { css, type CSSResult } from 'lit';

export const proposalRequestPanelStyles: CSSResult = css`
  .request-card__actions {
    border-block-start: var(--border-thin) solid var(--color-border);
  }

  /* The model menu sits in the ask's sentence, in the ask's type. */
  .proposal-model {
    display: inline-block;
    vertical-align: baseline;
  }

  .proposal-model__trigger::part(label) {
    font-size: inherit;
    font-weight: inherit;
  }

  .proposal-model wa-dropdown-item {
    font-size: var(--font-size-sm);
    font-weight: normal;
  }

  /* A script request's lede. */
  .proposal-card__lede {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--wa-space-2xs);
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .workflow-proposal__workflow-details {
    margin-block-start: var(--wa-space-2xs);
  }

  .workflow-proposal__plan-note {
    margin-block: var(--wa-space-2xs);
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .workflow-proposal__instruction {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    overflow-wrap: anywhere;
    max-height: 12em;
    overflow-y: auto;
    line-height: var(--line-height-normal);
    padding: var(--wa-space-2xs) 0;
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .workflow-proposal__instruction pre {
    white-space: pre-wrap;
  }

  /* A script request shows the whole source and the calls it issued. */
  .script-proposal__source {
    max-height: 10em;
    font-family: var(--wa-font-family-code);
    font-size: var(--font-size-xs);
  }

  .script-proposal__calls {
    margin: 0;
    padding-inline-start: 1.5em;
    font-family: var(--wa-font-family-code);
    font-size: var(--font-size-xs);
    overflow-wrap: anywhere;
  }

  .workflow-proposal__option-badges {
    display: flex;
    gap: var(--wa-space-2xs);
    flex-wrap: wrap;
    margin-block-start: var(--wa-space-2xs);
  }

  .workflow-proposal__files {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
    margin-block-start: var(--wa-space-2xs);
  }

  .workflow-proposal__files > div {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-normal);
  }

  .workflow-proposal__file-label {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-secondary);
  }

  .workflow-proposal__file-name {
    font-family: var(--wa-font-family-mono);
  }

  .workflow-proposal__file-name--readonly {
    color: var(--color-text-secondary);
  }

  .workflow-proposal__file-name--wrap {
    overflow-wrap: anywhere;
  }

  .workflow-proposal__input-files .workflow-proposal__file-label {
    color: var(--wa-color-text-normal);
  }

  .workflow-proposal__output-files .workflow-proposal__file-label {
    color: var(--color-text-link);
  }
`;
