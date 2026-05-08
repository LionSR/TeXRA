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

/**
 * Drive the CSS-only fade + height-collapse transition on a banner host.
 *
 * The shared `bannerStyles` selectors key off `[data-visible='true']` and the
 * accompanying `aria-hidden` attribute provides the matching a11y signal.
 * Centralising the writes keeps the five banner components from each carrying
 * their own copy of the visibility-derivation logic.
 */
export function applyBannerVisibility(host: HTMLElement, visible: boolean): void {
  host.dataset.visible = visible ? 'true' : 'false';
  host.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

export const bannerStyles: CSSResult = css`
  :host {
    /*
     * 1fr/0fr grid trick collapses the banner's height as part of the
     * fade-out so surrounding content slides up smoothly. The transition
     * runs in both directions (open and dismiss) with no JS timers.
     */
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--transition-normal);
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
    /* Subtle hairline above the variant border for refined density. */
    border-radius: var(--wa-border-radius-m, 6px);
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
    line-height: var(--line-height-relaxed, 1.5);
  }

  /*
   * Cohesive icon treatment across all banners — quiet circular tile
   * tinted by the variant colour. Establishes a consistent visual rhythm:
   * apiKey (warning), login (brand), dependency (warning), gettingStarted
   * (brand), agentConfig (warning) all share the same icon framing.
   */
  wa-callout::part(icon) {
    padding-inline-end: var(--wa-space-2xs);
    font-size: 0.95em;
    opacity: 0.92;
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

  /*
   * Bold cue for inline names — used by ApiKeyBanner ("<provider> API key
   * missing") and GettingStartedBanner ("Welcome to TeXRA!"). A touch
   * tighter letter-spacing distinguishes the lede from the body without
   * a font weight clash.
   */
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

  /*
   * Banner action buttons share the same compact, refined silhouette —
   * tighter padding than the WA default plain button, with a subtle
   * hover tint that uses the callout's surrounding tone.
   */
  .actions wa-button::part(base) {
    min-height: 24px;
    padding-inline: var(--wa-space-xs);
    border-radius: var(--wa-border-radius-s, 4px);
    font-size: var(--font-size-sm);
    transition:
      background-color var(--transition-fast),
      color var(--transition-fast);
  }

  .actions wa-button[appearance='plain']::part(base):hover {
    background: color-mix(
      in srgb,
      currentColor 8%,
      transparent
    );
  }
`;
