// Banner composition over the shared notice surface. This sheet owns only
// the message/action layout and contextual spacing; surfaceStyles owns the
// frame, padding and icon alignment used by every notice.

import { css, type CSSResult } from 'lit';
import { noticeStyles } from './surfaceStyles';

const bannerFrameStyles: CSSResult = css`
  ${noticeStyles}

  .banner-frame {
    min-height: 0;
  }

  wa-callout {
    margin-block-end: var(--message-gap);
  }

  .banner-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-xs) var(--wa-space-s);
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
    gap: var(--wa-space-xs);
    flex-shrink: 0;
  }
`;

export const bannerStyles: CSSResult = css`
  :host {
    display: block;
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
  }

  .settings-banner wa-callout::part(message) {
    width: 100%;
    min-width: 0;
  }

  .settings-banner-layout {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--wa-space-s);
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
    min-width: 0;
  }

  @container settings (max-width: 720px) {
    .settings-banner-layout {
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
    }

    .settings-banner-actions {
      grid-column: 2;
      width: 100%;
      justify-content: flex-start;
      max-width: none;
    }
  }
`;
