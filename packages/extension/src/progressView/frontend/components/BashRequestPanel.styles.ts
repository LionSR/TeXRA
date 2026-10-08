/** Component-scoped styles for {@link BashRequestPanel} (bash command approval requests). */

import { css, type CSSResult } from 'lit';

export const bashRequestPanelStyles: CSSResult = css`
  .bash-request__command {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    font-variant-ligatures: none;
    line-height: var(--line-height-normal);
    text-align: start;
  }

  .bash-request__command .tool-command-input {
    direction: ltr;
    text-align: left;
  }
`;
