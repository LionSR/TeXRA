/** Component-scoped styles for {@link BashRequestPanel} (bash command approval requests). */

import { css, type CSSResult } from 'lit';

export const bashRequestPanelStyles: CSSResult = css`
  .bash-approval-request__command {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
  }

  .bash-approval-request__cwd {
    color: var(--wa-color-text-quiet);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-xs);
    margin-bottom: var(--wa-space-xs);
    overflow-wrap: anywhere;
  }

  .bash-approval-request__cwd span {
    color: var(--color-text-secondary);
  }

  .bash-approval-request__command .code-block pre {
    white-space: pre-wrap;
    word-break: break-word;
  }
`;
