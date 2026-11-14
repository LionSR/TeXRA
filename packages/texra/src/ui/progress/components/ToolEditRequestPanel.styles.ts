/** Component-scoped styles for {@link ToolEditRequestPanel} (tool edit approval requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@ui/styles';

export const toolEditRequestPanelStyles: CSSResult = css`
  /* The line-change chip (buildLineChangeStats). */
  .file-stats {
    display: inline-flex;
    align-items: baseline;
    gap: ${sp.small};
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
  }

  .file-stats > .added {
    color: var(--color-added);
  }

  .file-stats > .removed {
    color: var(--color-removed);
  }
`;
