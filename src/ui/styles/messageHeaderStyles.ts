import { css } from 'lit';

import { panelHeaderStyles, panelContentStyles } from './surfaceStyles';

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

/** Identical disclosure geometry for user, assistant and error messages. */
export const messageDisclosureStyles = css`
  wa-details.message-disclosure::part(summary) {
    width: 100%;
    min-width: 0;
  }
  .message-disclosure > .message-header {
    width: 100%;
    padding: 0;
  }
  wa-details.message-disclosure::part(header) {
    ${panelHeaderStyles}
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--control-size-s);
    gap: var(--wa-space-xs);
  }
  wa-details.message-disclosure::part(icon) {
    display: grid;
    place-items: center;
    width: var(--control-size-s);
    height: var(--control-size-s);
    margin: 0;
  }
  wa-details.message-disclosure::part(content) {
    ${panelContentStyles}
  }
`;
