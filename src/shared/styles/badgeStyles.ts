import { css, type CSSResult } from 'lit';

// NOTE: the hand-rolled badge/pill rules formerly here (.badge, .category-badge,
// .agent-category-badge, .tinted-badge) were retired in favor of native <wa-badge>,
// and the dead .no-data/.loading empty-state rules in favor of renderEmptyState.
// What remains is the search-match highlight (mark.js) used by list views.
// TODO: rename this export to searchHighlightStyles and drop it from importers
// that no longer render <mark> (only HistoryItemElement still needs it).

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

export const badgeStyles: CSSResult[] = [searchHighlightStyles];
