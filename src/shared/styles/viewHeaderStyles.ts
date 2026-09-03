import { css, type CSSResult } from 'lit';

/**
 * Box layout shared by every `.view-header` rendered by `renderViewHeader`
 * (`@shared/wa/viewHeader`) — MainApp's launcher header and ProgressApp's
 * stream header both mount that same markup. Each consumer composes this
 * sheet ahead of its own stylesheet and layers only its per-view delta
 * (padding, border) on top; do not fold this into `commonViewStyles`, whose
 * own `.view-header` selector carries unrelated page/section-header chrome
 * (`justify-content: space-between`, `margin-bottom`, h1/h2 rules) and would
 * clash (see its `visuallyHiddenStyles` doc comment).
 */
export const viewHeaderLayoutStyles: CSSResult = css`
  .view-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex-shrink: 0;
  }
`;

const waTabThemeTokenStyles: CSSResult = css`
  --track-width: var(--border-thin);
  --track-color: var(--color-border);
  --indicator-color: var(--wa-color-brand-fill-loud);
  --indicator-width: 2px;
`;

/**
 * The tab rail inside that same `.view-header`. Composed alongside
 * {@link viewHeaderLayoutStyles} by both consumers, and scoped to the header
 * markup `renderViewHeader` emits, so the two sheets live in one file.
 */
export const viewTabStyles: CSSResult = css`
  .view-header wa-tab-group.view-tabs {
    flex: 1;
    min-width: 0;
    ${waTabThemeTokenStyles}
  }

  .view-header wa-tab-group.view-tabs::part(body) {
    display: none;
  }

  /* Stricter compactness — small font, tight vertical padding. */
  wa-tab {
    font-size: var(--font-size-sm);
    letter-spacing: -0.005em;
  }

  wa-tab::part(base) {
    padding-block: 5px;
    padding-inline: var(--wa-space-s);
    color: color-mix(in srgb, var(--wa-color-text-normal) 70%, transparent);
    border-radius: var(--border-radius) var(--border-radius) 0 0;
  }

  /*
   * Selected tab: full text contrast + slight font-weight bump. The brand
   * indicator bar (--indicator-color above) provides the chromatic accent;
   * the label itself stays neutral so the active row reads as "anchored",
   * not coloured.
   */
  wa-tab[active]::part(base) {
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold, 600);
  }
`;
