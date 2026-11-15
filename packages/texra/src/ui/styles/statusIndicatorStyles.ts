import { css, type CSSResult } from 'lit';

import { toneStyles } from './toneStyles';

/** The 8px status dot, filled with its tone's colour alone: an `opacity`
 *  over a translucent token falls under the 3:1 non-text contrast minimum. */
export const statusIndicatorStyles: CSSResult = css`
  ${toneStyles}

  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background-color: var(--tone-color, var(--color-text-muted));
  }
`;
