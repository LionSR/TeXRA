import { css, type CSSResult } from 'lit';

/**
 * Compact `wa-badge` chip look — tighter padding/gap/font-size than the
 * component default, plus a medium font weight. This is the app-wide
 * "status chip" idiom (goal chip, PR-state pill, task-status, tool-id tag);
 * apply the `badge-compact` class to the `wa-badge` element alongside its
 * own variant/identifying class.
 */
export const compactBadgeStyles: CSSResult = css`
  .badge-compact::part(base) {
    gap: var(--wa-space-3xs);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-medium);
  }
`;

/** Search-match highlight rules for mark.js output in history item rows. */
export const searchHighlightStyles: CSSResult = css`
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
