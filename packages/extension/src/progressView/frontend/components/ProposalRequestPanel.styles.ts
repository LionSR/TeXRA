/** Component-scoped styles for {@link ProposalRequestPanel} (workflow proposal requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@ui/styles';

export const proposalRequestPanelStyles: CSSResult = css`
  :host {
    --request-accent: var(--wa-color-text-link);
  }

  /* The pickers open floating menus a scrolling body would clip, so the
     whole card scrolls in the dock instead; the rule keeps what scrolls
     under the sticky action row from running into it. */
  .request-card__details {
    max-height: none;
    overflow-y: visible;
  }

  .request-card__actions {
    border-block-start: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .workflow-proposal__pickers {
    display: flex;
    flex-wrap: wrap;
    gap: ${sp.medium};
  }

  .proposal-model-dropdown {
    min-width: 6rem;
    max-width: 9rem;
  }

  .proposal-agent-dropdown {
    min-width: 5rem;
    max-width: 8rem;
  }

  /* A script request's lede. */
  .proposal-card__lede {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: ${sp.small};
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .workflow-proposal__workflow-details {
    margin-block-start: ${sp.small};
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
