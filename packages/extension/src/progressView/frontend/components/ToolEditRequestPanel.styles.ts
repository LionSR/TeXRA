/** Component-scoped styles for {@link ToolEditRequestPanel} (tool edit approval requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@ui/styles';

export const toolEditRequestPanelStyles: CSSResult = css`
  :host {
    --request-accent: var(--wa-color-text-normal);
  }

  .tool-edit__source-tool {
    font-family: var(--wa-font-family-mono);
    font-variant-ligatures: none;
    color: var(--wa-color-text-normal);
    overflow-wrap: anywhere;
  }

  .tool-edit__diff {
    display: inline-flex;
    align-items: baseline;
    gap: ${sp.small};
    font-variant-numeric: tabular-nums;
  }

  .tool-edit__diff-added,
  .tool-edit__diff-removed {
    font-size: var(--font-size-xs);
  }

  .tool-edit__diff-added {
    color: var(--color-added);
  }

  .tool-edit__diff-removed {
    color: var(--color-removed);
  }

  .tool-edit__diff-label {
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
  }
`;
