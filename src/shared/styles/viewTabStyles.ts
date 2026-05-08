import { css, type CSSResult } from 'lit';

export const waTabThemeTokenStyles: CSSResult = css`
  --track-width: var(--border-thin);
  --track-color: var(--color-border);
  --indicator-color: var(--texra-focusBorder);
  --indicator-width: 1.5px;
`;

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
  }

  wa-tab::part(base) {
    padding-block: 4px;
    padding-inline: var(--spacing-medium);
  }
`;
