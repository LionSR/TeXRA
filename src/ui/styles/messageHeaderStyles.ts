import { css } from 'lit';

/** The label, timestamp and action slots share columns across message kinds. */
export const messageHeaderStyles = css`
  .message-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto var(
        --message-actions-width,
        calc(2 * var(--control-size-s) + var(--wa-space-xs))
      );
    align-items: center;
    gap: var(--wa-space-xs);
    min-height: var(--control-size-s);
    padding: 0;
    min-width: 0;
  }
  .message-label {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-width: 0;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
  }
  .message-label > wa-icon {
    flex: 0 0 var(--font-size-icon-sm);
    width: var(--font-size-icon-sm);
    height: var(--font-size-icon-sm);
  }
  .message-timestamp {
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--wa-color-text-quiet);
    white-space: nowrap;
  }
  .message-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--wa-space-xs);
  }
`;
