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

  /* Extend .details-summary from commonViewStyles with accent color */
  .details-summary,
  .details-summary .icon,
  .context-title {
    color: var(--accent-color, var(--wa-color-text-normal));
  }

  .context-title {
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
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-sm);
  }

  .stat-item wa-icon {
    color: var(--color-text-muted);
  }

  .summary-block {
    margin-top: var(--wa-space-2xs);
    display: block;
    width: 100%;
  }

  .summary-title {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    margin-bottom: var(--wa-space-3xs);
  }

  .summary-text {
    margin: 0;
    padding: var(--wa-space-2xs);
    white-space: pre-wrap;
    word-break: break-word;
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius-small);
    background: var(--wa-color-surface-raised);
  }
`;
