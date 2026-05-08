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

  /* Compact callout chrome — tighten WA default padding ~20%. */
  wa-callout::part(message) {
    padding-block: 6px;
  }

  wa-callout::part(icon) {
    padding-inline-end: 8px;
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
