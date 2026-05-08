// Shared layout for inline banners. wa-callout owns the variant color,
// border, and padding; this stylesheet just lays out the message + actions
// inside the callout's default slot.

import { css, type CSSResult } from 'lit';

export const warningBannerStyles: CSSResult = css`
  :host {
    display: block;
  }

  wa-callout.warning-banner {
    margin-bottom: var(--spacing-large);
  }

  .banner-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-tiny) var(--spacing-medium);
  }

  .banner-row .hint {
    width: 100%;
    font-size: var(--font-size-sm);
    opacity: var(--opacity-normal);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }
`;
