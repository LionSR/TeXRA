import { css, type CSSResult } from 'lit';

// NOTE: the hand-rolled badge/pill rules formerly here (.badge, .category-badge,
// .agent-category-badge, .tinted-badge) were retired in favor of native <wa-badge>.
// What remains is search-highlight and empty-state styling shared by list views.

const searchHighlightStyles: CSSResult = css`
  mark {
    background-color: var(--wa-color-editor-find-match-highlight, #ffef0b80);
    color: var(--wa-color-editor-find-match-highlight-fg, inherit);
    padding: 0;
    border-radius: var(--border-radius-small);
  }

  mark[data-current='true'] {
    background-color: var(--wa-color-editor-find-match, #ff8b0088);
    outline: var(--border-thin) solid var(--wa-color-focus);
  }
`;

const emptyStateStyles: CSSResult = css`
  .no-data {
    color: var(--color-text-secondary);
    font-style: italic;
    text-align: center;
    padding: var(--wa-space-l);
  }

  .loading {
    color: var(--color-text-secondary);
    font-style: italic;
  }
`;

export const badgeStyles: CSSResult[] = [
  searchHighlightStyles,
  emptyStateStyles,
];
