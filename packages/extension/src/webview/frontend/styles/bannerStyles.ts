// Shared layout for inline wa-callout banners. wa-callout owns the variant
// color, border, and padding; this stylesheet handles host display, the
// bottom margin, and the row layout for the message + action buttons inside
// the callout's default slot.
//
// Banners always render their wa-callout into the DOM and use the
// `data-visible` attribute on the host (driven by the `visible` property /
// equivalent state) to drive a CSS-only fade + height-collapse transition.
// This avoids the abrupt mount/unmount jump from `if (!visible) return
// nothing` while keeping JS out of the animation path.

import { css, type CSSResult } from 'lit';

export const bannerStyles: CSSResult = css`
  :host {
    /*
     * 1fr/0fr grid trick collapses the banner's height as part of the
     * fade-out so surrounding content slides up smoothly. The transition
     * runs in both directions (open and dismiss) with no JS timers.
     */
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 200ms ease;
  }

  :host([data-visible='true']) {
    grid-template-rows: 1fr;
  }

  .banner-frame {
    overflow: hidden;
    min-height: 0;
  }

  wa-callout {
    margin-bottom: var(--wa-space-s);
    opacity: 0;
    transform: translateY(calc(-1 * var(--wa-space-2xs)));
    transition:
      opacity 180ms ease,
      transform 180ms ease,
      visibility 0s linear 180ms;
    pointer-events: none;
    /* Compact callout chrome — stricter minimalism, tight banner padding. */
    --padding: var(--wa-space-2xs) var(--wa-space-xs);
  }

  :host([data-visible='true']) wa-callout {
    opacity: 1;
    transform: translateY(0);
    visibility: visible;
    transition:
      opacity 180ms ease,
      transform 180ms ease,
      visibility 0s linear 0s;
    pointer-events: auto;
  }

  /*
   * When the banner is hidden, drop its bottom margin so the layout fully
   * collapses. The margin transition runs alongside the grid-row collapse.
   */
  :host(:not([data-visible='true'])) wa-callout {
    margin-bottom: 0;
  }

  wa-callout::part(message) {
    padding-block: var(--wa-space-2xs);
  }

  wa-callout::part(icon) {
    padding-inline-end: var(--wa-space-2xs);
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
    opacity: var(--opacity-normal);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex-shrink: 0;
  }
`;
