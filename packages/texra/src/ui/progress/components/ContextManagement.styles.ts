/** Component-scoped styles for {@link ContextManagement} (context event banners). */

import { css, type CSSResult } from 'lit';

export const contextManagementStyles: CSSResult = css`
  :host {
    display: block;
    margin: var(--wa-space-2xs) 0;
  }

  wa-details {
    margin: 0;
  }

  /* Keep the event color on the decorative status cue. Chart tokens are not
     guaranteed to meet text contrast across every host theme. */
  .details-summary .icon {
    color: var(--accent-color, var(--wa-color-text-normal));
  }

  .context-title {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
  }

  .context-content {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-s);
  }

  .stat-item {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-sm);
  }

  .stat-item wa-icon {
    color: var(--color-text-muted);
  }

  .stat-value {
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }
`;
