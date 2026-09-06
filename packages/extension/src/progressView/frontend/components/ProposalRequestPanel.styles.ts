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
    margin-inline-end: ${sp.small};
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

  /* Model dropdown floats to the trailing edge of the header row. */
  .workflow-proposal__model-select {
    margin-inline-start: auto;
  }

  .proposal-model-dropdown {
    min-width: 6rem;
    max-width: 9rem;
  }

  .proposal-agent-dropdown {
    min-width: 5rem;
    max-width: 8rem;
  }

  .workflow-proposal__workflow-summary {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    min-width: 0;
    white-space: nowrap;
    font-size: var(--font-size-sm);
  }

  .workflow-proposal__workflow-summary wa-icon {
    flex: 0 0 auto;
  }

  .workflow-proposal__workflow-name {
    min-width: 4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: var(--font-weight-semibold);
  }

  .workflow-proposal__workflow-progress {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  /* The card (board W0): the head, the lede, one row per declared phase. */
  .proposal-card__head {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    margin-block-start: ${sp.small};
    padding: ${sp.small} ${sp.medium};
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-warning-fill-quiet);
    color: var(--wa-color-warning-on-quiet);
    font-size: var(--font-size-sm);
  }

  .proposal-card__summary {
    margin-inline-start: auto;
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  .proposal-card__lede {
    display: flex;
    align-items: baseline;
    gap: ${sp.small};
    min-width: 0;
    padding: ${sp.small} ${sp.medium} 0;
    font-size: var(--font-size-sm);
  }

  .proposal-card__phases {
    display: flex;
    flex-direction: column;
    margin-block-start: ${sp.small};
  }

  .proposal-card__phase {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    min-height: 1.75rem;
    padding: 0 ${sp.medium};
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
    font-size: var(--font-size-sm);
  }

  .proposal-card__phase wa-icon {
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .proposal-card__phase-agents {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .proposal-card__phase-calls {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }

  .proposal-card__skip {
    margin-inline-start: auto;
  }

  .workflow-proposal__cost-warning {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    margin-block-start: ${sp.small};
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .workflow-proposal__workflow-details {
    margin-block-start: ${sp.small};
  }

  .workflow-proposal__task-list {
    margin-block: ${sp.small};
    padding-inline-start: var(--wa-space-l);
  }

  .workflow-proposal__plan-note {
    margin-block: ${sp.small};
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
    margin-block-start: ${sp.small};
  }

  .workflow-proposal__files {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    margin-block-start: ${sp.small};
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

  /* Radius only — the ring comes from focusRingStyles. */
  .workflow-proposal__file-name:focus-visible {
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
    overflow-wrap: anywhere;
  }

  .workflow-proposal__input-files .workflow-proposal__file-label {
    color: var(--wa-color-text-normal);
  }

  .workflow-proposal__output-files .workflow-proposal__file-label {
    color: var(--wa-color-text-link);
  }
`;
