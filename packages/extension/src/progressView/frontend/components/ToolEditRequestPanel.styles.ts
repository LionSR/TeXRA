/** Component-scoped styles for {@link ToolEditRequestPanel} (tool edit approval requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@shared/styles';
import { splitButtonStyles } from '@shared/styles/controlStyles';

export const toolEditRequestPanelStyles: CSSResult = css`
  ${splitButtonStyles}

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
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
    opacity: var(--opacity-normal);
  }

  /*
   * The diff control is a split button. Its fused-pill chrome — squared inner
   * corners, the pulled-in caret, the hover outline that boxes both halves —
   * comes from the shared splitButtonStyles above, which this component's
   * markup opts into by carrying both the shared .split-button* classes and
   * its own .diff-* names. Only the action-row width budget is local: the
   * button sits among Approve/Reject siblings and must not grow to fill a wide
   * panel.
   */
  .approval-request__actions .diff-dropdown {
    flex: 1 1 7rem;
    max-width: min(8.25rem, 100%);
  }
`;
