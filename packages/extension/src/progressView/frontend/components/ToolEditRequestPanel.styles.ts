/** Component-scoped styles for {@link ToolEditRequestPanel} (tool edit approval requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@shared/styles';

export const toolEditRequestPanelStyles: CSSResult = css`
  .approval-request__path {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    color: var(--color-text-link);
    word-break: break-word;
  }

  .approval-request__diff {
    display: inline-flex;
    align-items: baseline;
    gap: ${sp.small};
  }

  .approval-request__diff-added,
  .approval-request__diff-removed {
    font-size: var(--font-size-xs);
  }

  .approval-request__diff-added {
    color: var(--color-added);
  }

  .approval-request__diff-removed {
    color: var(--color-removed);
  }

  .approval-request__diff-label {
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
  }

  /* Web Awesome owns the split geometry. Keep the diff control compact among
     its Approve/Reject siblings and reserve a narrow trailing caret segment. */
  .approval-request__actions .diff-dropdown {
    flex: 0 1 8.25rem;
    min-width: 0;
    max-width: min(8.25rem, 100%);
  }

  .approval-request__actions .diff-dropdown .diff-main-button {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    max-width: none;
  }

  .diff-dropdown-trigger {
    width: 1.5rem;
    min-width: 1.5rem;
  }

  .diff-dropdown-trigger::part(base) {
    padding-inline: 0;
  }

  .diff-dropdown-trigger wa-icon {
    font-size: var(--font-size-sm);
    transition: transform var(--transition-fast);
  }

  .diff-dropdown-menu[open] .diff-dropdown-trigger wa-icon {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .diff-dropdown-trigger wa-icon {
      transition: none;
    }
  }
`;
