// Third-party imports
import { css } from 'lit';

/** Shared styles for toolbar toggle buttons in stream headers. */
export const toolbarToggleStyles = css`
  .bypass-toggle-button {
    flex-shrink: 0;
  }

  .bypass-toggle-button.is-active {
    border-radius: var(--border-radius);
    /* AUTO-EDIT / AUTO-BASH match the CLI warning badges. */
    --_toggle-color: var(--color-warning);
    color: var(--_toggle-color);
    background-color: color-mix(in srgb, var(--_toggle-color) 15%, transparent);
  }

  /* AUTO-TASK is the complete grant — CLI uses the error badge. */
  .bypass-toggle-button--task.is-active {
    --_toggle-color: var(--color-error);
  }
`;
