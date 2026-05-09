// Shared layout for inline wa-callout banners. wa-callout owns the variant
// color, border, and padding; this stylesheet handles host display and the
// row layout for the message + action buttons inside the callout's default slot.

import { css, type CSSResult } from 'lit';

/** Reflect banner visibility onto the host for CSS targeting and a11y. */
export function applyBannerVisibility(
  host: HTMLElement,
  visible: boolean,
): void {
  host.dataset.visible = visible ? 'true' : 'false';
  host.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

export const bannerStyles: CSSResult = css`
  :host {
    display: block;
  }

  :host(:not([data-visible='true'])) {
    display: none;
  }

  .banner-frame {
    min-height: 0;
  }

  wa-callout {
    margin-bottom: var(--wa-space-s);
    --padding: var(--wa-space-2xs) var(--wa-space-xs);
  }

  wa-callout::part(message) {
    padding-block: var(--wa-space-2xs);
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
    opacity: 0.7;
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
