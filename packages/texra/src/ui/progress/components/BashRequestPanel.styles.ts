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

  /* The ask already says it is a command; the block is the text alone. */
  .bash-request__command .code-block {
    border: 0;
    border-radius: var(--field-radius);
    background: var(--wa-color-surface-lowered);
  }

  .bash-request__command .code-block-header {
    display: none;
  }

  .bash-request__command .tool-command-input {
    direction: ltr;
    text-align: left;
  }
`;
