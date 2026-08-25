// Third-party imports
import { css } from 'lit';

/** Shared styles for toolbar toggle buttons in stream headers. */
export const toolbarToggleStyles = css`
  .yolo-toggle-button,
  .bash-toggle-button,
  .super-yolo-toggle-button {
    flex-shrink: 0;
  }

  .yolo-toggle-button.is-active,
  .bash-toggle-button.is-active,
  .super-yolo-toggle-button.is-active {
    border-radius: var(--border-radius);
  }

  /* Match CLI status-bar badges: AUTO-TASK is the complete grant (error),
     AUTO-EDIT / AUTO-BASH are per-kind (warning). */
  .yolo-toggle-button.is-active,
  .bash-toggle-button.is-active {
    --_toggle-color: var(--color-warning);
  }

  .super-yolo-toggle-button.is-active {
    --_toggle-color: var(--color-error);
  }

  :is(
    .yolo-toggle-button,
    .bash-toggle-button,
    .super-yolo-toggle-button
  ).is-active {
    color: var(--_toggle-color);
    background-color: color-mix(in srgb, var(--_toggle-color) 15%, transparent);
  }
`;
