import { css } from 'lit';

/** One trailing metadata/action group, without empty reserved button columns. */
export const messageHeaderStyles = css`
  .message-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-height: var(--control-size-s);
    padding: 0;
    min-width: 0;
  }
  .message-label {
    display: flex;
    flex: 1;
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
    flex: none;
    margin-inline-start: auto;
    text-align: end;
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--wa-color-text-quiet);
    white-space: nowrap;
  }
  .message-actions {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: flex-end;
    gap: var(--wa-space-xs);
  }
  .message-header > .banner-content-copy {
    flex: none;
    margin: 0;
    padding: 0;
    opacity: 1;
  }
`;
