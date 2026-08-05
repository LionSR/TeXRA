/** Component-scoped styles for {@link BashRequestPanel} (bash command approval requests). */

import { css, type CSSResult } from 'lit';

export const bashRequestPanelStyles: CSSResult = css`
  .bash-approval-request__command {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
  }

  /* The directory a command will run in is the security-relevant field of
     this prompt, so it is not the smallest, faintest text in it.
     --font-size-xs resolves to 10.4px (13px x 0.8), under the ~12px floor,
     and --wa-color-text-quiet measured 4.40:1 on Light Modern, under AA. The
     label stays quiet; the path itself takes the normal text colour so the
     value outranks its label. */
  .bash-approval-request__cwd {
    color: var(--wa-color-text-quiet);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    margin-bottom: var(--wa-space-xs);
    overflow-wrap: anywhere;
  }

  .bash-approval-request__cwd span {
    color: var(--wa-color-text-normal);
  }

  .bash-approval-request__command .code-block pre {
    white-space: pre-wrap;
    word-break: break-word;
  }
`;
