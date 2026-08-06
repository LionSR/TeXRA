// Shared layout for inline wa-callout banners. wa-callout owns the variant
// color and border; we override its padding here (its :host hardcodes 1em),
// and this stylesheet handles host display and the row layout for the message
// + action buttons inside the callout's default slot.

import { css, type CSSResult } from 'lit';

const bannerFrameStyles: CSSResult = css`
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
    /* Full-sentence reading text, so it takes the ≥4.5:1 token rather than
       the 3:1 non-text --color-text-muted. */
    color: var(--wa-color-text-quiet);
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

  /* Banner action buttons are bare <wa-button>s (no skin class), so their skin
     is applied by descendant selector here. A banner is a tight band, so it
     takes the small step off the control scale. */
  .actions wa-button::part(base) {
    min-height: var(--control-size-s);
    padding-inline: var(--control-padding-inline);
    border-radius: var(--border-radius-medium);
    font-size: var(--font-size-sm);
    transition: background-color var(--transition-fast);
  }

  /* Ghost skin for the secondary actions only. An outer ::part() rule beats
     wa-button's own :host([appearance='filled']) fill regardless of
     specificity, so a banner's one primary CTA has to be excluded by selector
     or it silently loses its fill and reads as another dismiss link. */
  .actions wa-button:not([appearance~='filled'])::part(base) {
    border: 0;
    background: transparent;
  }

  .actions wa-button:not([appearance~='filled'])::part(base):hover {
    background: var(--surface-hover);
  }
`;

export const bannerStyles: CSSResult = css`
  :host {
    display: block;
  }

  /* Stateful banners reflect a boolean \`visible\` property to the host. The
     frame styles stay separate so ordinary settings tabs can use the same
     banner chrome without disappearing. */
  :host(:not([visible])) {
    display: none;
  }

  ${bannerFrameStyles}
`;

/** Canonical Settings banner composition: one callout, title/description
 * hierarchy, optional detail content, and a wrapping action row. */
export const settingsBannerStyles: CSSResult = css`
  ${bannerFrameStyles}

  .settings-banner.banner-frame {
    margin-bottom: var(--wa-space-s);
  }

  .settings-banner wa-callout {
    margin-bottom: 0;
    border-radius: var(--border-radius);
  }

  .settings-banner wa-callout::part(message) {
    width: 100%;
    min-width: 0;
  }

  .settings-banner-layout {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--wa-space-xs);
    min-width: 0;
  }

  .settings-banner-icon {
    align-self: start;
    color: var(--wa-color-text-normal);
  }

  .settings-banner-body {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--wa-space-2xs);
  }

  .settings-banner-title {
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-medium);
  }

  .settings-banner-description,
  .settings-banner-detail {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .settings-banner-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--wa-space-2xs);
    max-width: min(42rem, 46%);
  }

  @container settings (max-width: 720px) {
    .settings-banner-layout {
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
    }

    .settings-banner-actions {
      grid-column: 2;
      width: 100%;
      justify-content: flex-end;
      max-width: none;
    }
  }
`;
