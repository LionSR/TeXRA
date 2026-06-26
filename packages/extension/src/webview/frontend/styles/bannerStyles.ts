// Shared layout for inline wa-callout banners. wa-callout owns the variant
// color and border; we override its padding here (its :host hardcodes 1em),
// and this stylesheet handles host display and the row layout for the message
// + action buttons inside the callout's default slot.

import { css, type CSSResult } from 'lit';

export const bannerStyles: CSSResult = css`
  :host {
    display: block;
  }

  /* Banners reflect a boolean \`visible\` property to the host attribute; when
     absent the host is removed from layout (and via display:none from the
     accessibility tree, so no aria-hidden is needed). */
  :host(:not([visible])) {
    display: none;
  }

  .banner-frame {
    min-height: 0;
  }

  wa-callout {
    margin-bottom: var(--wa-space-s);
    /* wa-callout's :host hardcodes padding: 1em and never reads a --padding
       custom property, so set the real padding to keep the banner compact.
       Outer-scope rules win over the component's :host via shadow encapsulation. */
    padding: var(--wa-space-xs) var(--wa-space-s);
  }

  wa-callout::part(message) {
    padding-block: 0;
    line-height: var(--line-height-normal);
  }

  wa-callout::part(icon) {
    padding-inline-end: var(--wa-space-2xs);
    font-size: 0.95em;
  }

  .banner-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-3xs) var(--wa-space-xs);
  }

  .banner-row .hint {
    width: 100%;
    font-size: var(--font-size-sm);
    opacity: var(--opacity-subtle);
    line-height: var(--line-height-relaxed, 1.5);
  }

  .banner-row strong {
    font-weight: var(--font-weight-semibold, 600);
    letter-spacing: -0.005em;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    flex-shrink: 0;
  }

  .actions wa-button::part(base) {
    min-height: 24px;
    padding-inline: var(--wa-space-xs);
    border-radius: var(--wa-border-radius-s, 4px);
    font-size: var(--font-size-sm);
  }
`;
