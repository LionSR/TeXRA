// Third-party imports
import { css } from 'lit';

/** Shared styles for toolbar toggle buttons in stream headers. */
export const toolbarToggleStyles = css`
  .yolo-toggle-button,
  .super-yolo-toggle-button {
    flex-shrink: 0;
  }

  .yolo-toggle-button.is-active,
  .super-yolo-toggle-button.is-active {
    border-radius: var(--border-radius);
  }

  .yolo-toggle-button.is-active {
    --_toggle-color: var(--color-error);
  }

  .super-yolo-toggle-button.is-active {
    --_toggle-color: var(--color-warning);
  }

  :is(.yolo-toggle-button, .super-yolo-toggle-button).is-active {
    color: var(--_toggle-color);
    background-color: color-mix(in srgb, var(--_toggle-color) 15%, transparent);
  }
`;
