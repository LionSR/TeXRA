import { css, type CSSResult } from 'lit';

export const statusIndicatorStyles: CSSResult = css`
  .status-indicator,
  .tab-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-subtle, 0.7);
  }

  .status-indicator.is-running,
  .tab-status.is-running {
    background-color: var(--color-success, #4caf50);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-stopped,
  .tab-status.is-stopped {
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-subtle, 0.7);
  }

  .status-indicator.is-error,
  .tab-status.is-error {
    background-color: var(--color-error, #f44336);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-waiting,
  .tab-status.is-waiting {
    background-color: var(--wa-color-text-link);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-resuming,
  .tab-status.is-resuming {
    background-color: var(--wa-color-text-link);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-initializing,
  .tab-status.is-initializing {
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-full);
  }

  .status-indicator.is-ready,
  .tab-status.is-ready {
    background-color: var(--wa-color-text-quiet);
    opacity: var(--opacity-disabled, 0.5);
  }

  .status-text {
    font-size: var(--font-size-sm, 12px);
    text-transform: capitalize;
  }

  .status-text.is-running {
    color: var(--color-success, #4caf50);
  }

  .status-text.is-stopped {
    color: var(--color-text-secondary, var(--wa-color-text-quiet));
  }

  .status-text.is-error {
    color: var(--color-error, #f44336);
  }

  .status-text.is-waiting,
  .status-text.is-resuming,
  .status-text.is-initializing {
    color: var(--wa-color-text-link);
  }
`;
