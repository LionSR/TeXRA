// Third-party imports
import { css } from 'lit';

/** Shared styles for toolbar toggle buttons in stream headers. */
export const toolbarToggleStyles = css`
  .bypass-toggle-button {
    flex-shrink: 0;
  }

  /* AUTO-EDIT / AUTO-BASH match the CLI warning badges. Targets ::part(base)
     rather than the host: the pressed state's action-icon-button skin
     (controlStyles.ts) also paints ::part(base), and this rule must win that
     tie by winning the cascade at equal specificity — toolbarToggleStyles is
     adopted after commonViewStyles in StreamHeader.ts — for one fill at one
     radius instead of two mismatched stacked fills. */
  .bypass-toggle-button.is-active::part(base) {
    --_toggle-color: var(--color-warning);
    color: var(--_toggle-color);
    border-color: color-mix(in srgb, var(--_toggle-color) 40%, transparent);
    background-color: color-mix(in srgb, var(--_toggle-color) 15%, transparent);
  }

  /* AUTO-TASK is the complete grant — CLI uses the error badge. */
  .bypass-toggle-button--task.is-active::part(base) {
    --_toggle-color: var(--color-error);
  }
`;
