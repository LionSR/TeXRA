/** Component-scoped styles for {@link ProposalRequestPanel} (workflow proposal requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@shared/styles';

export const proposalRequestPanelStyles: CSSResult = css`
  .workflow-proposal__header-row {
    display: flex;
    align-items: baseline;
    gap: ${sp.medium};
    flex-wrap: wrap;
  }

  .workflow-proposal__agent {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-link);
  }

  .workflow-proposal__model {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .workflow-proposal__model::before {
    content: '\u2022';
    margin-right: ${sp.small};
  }

  .workflow-proposal__agent-select,
  .workflow-proposal__model-select {
    display: flex;
    align-items: center;
    gap: ${sp.small};
  }

  .workflow-proposal__agent-select wa-icon,
  .workflow-proposal__model-select wa-icon {
    color: var(--wa-color-text-quiet);
    flex-shrink: 0;
  }

  /* Model dropdown floats to the right edge of the header row. */
  .workflow-proposal__model-select {
    margin-left: auto;
  }

  .proposal-model-dropdown {
    min-width: 6rem;
    max-width: 9rem;
  }

  .proposal-agent-dropdown {
    min-width: 5rem;
    max-width: 8rem;
  }

  .workflow-proposal__instruction {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
    line-height: var(--line-height-normal);
    padding: ${sp.small} 0;
    border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .workflow-proposal__instruction pre {
    white-space: pre-wrap;
  }

  .workflow-proposal__extract-flags {
    display: flex;
    gap: ${sp.small};
    flex-wrap: wrap;
    margin-top: ${sp.small};
  }

  .workflow-proposal__files {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    margin-top: ${sp.small};
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
    color: var(--wa-color-text-link);
    cursor: pointer;
  }

  .workflow-proposal__file-name:hover {
    text-decoration: underline;
    color: var(--wa-color-text-link-active, var(--wa-color-text-link));
  }

  .workflow-proposal__file-name:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: var(--border-thin);
    border-radius: var(--border-radius-small);
  }

  .workflow-proposal__file-name--readonly {
    color: var(--color-text-secondary);
    cursor: default;
  }

  .workflow-proposal__file-name--readonly:hover {
    text-decoration: none;
    color: var(--color-text-secondary);
  }

  .workflow-proposal__file-name--wrap {
    word-break: break-word;
  }

  .workflow-proposal__input-files .workflow-proposal__file-label {
    color: var(--wa-color-text-normal);
  }

  .workflow-proposal__output-files .workflow-proposal__file-label {
    color: var(--wa-color-text-link);
  }
`;
