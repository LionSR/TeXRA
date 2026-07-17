import { css, type CSSResult } from 'lit';

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
