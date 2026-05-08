// Shared layout for inline wa-callout banners. wa-callout owns the variant
// color, border, and padding; this stylesheet handles host display, the
// bottom margin, and the row layout for the message + action buttons inside
// the callout's default slot.

import { css, type CSSResult } from 'lit';

export const bannerStyles: CSSResult = css`
  :host {
    display: block;
  }

  wa-callout {
    margin-bottom: var(--spacing-large);
  }

  /* Compact callout chrome — stricter minimalism, tight banner padding. */
  wa-callout {
    --padding: 4px 8px;
  }

  wa-callout::part(message) {
    padding-block: 4px;
  }

  wa-callout::part(icon) {
    padding-inline-end: 6px;
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
    flex-shrink: 0;
  }
`;
