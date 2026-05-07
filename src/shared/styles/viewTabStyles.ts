import { css, type CSSResult } from 'lit';

export const waTabThemeTokenStyles: CSSResult = css`
  --track-width: var(--border-thin);
  --track-color: var(--color-border);
  --indicator-color: var(--texra-focusBorder);
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
`;
