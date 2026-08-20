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
