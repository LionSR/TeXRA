import { css, type CSSResult } from 'lit';

export const statusIndicatorStyles: CSSResult = css`
  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-subtle, 0.7);
  }

  .status-indicator.is-running {
    background-color: var(--color-success);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-completed,
  .status-indicator.is-cancelled {
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-subtle, 0.7);
  }

  .status-indicator.is-failed {
    background-color: var(--color-error);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-waiting,
  .status-indicator.is-resuming {
    background-color: var(--wa-color-text-link);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-starting {
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-ready {
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-disabled, 0.5);
  }
`;
