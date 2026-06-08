import { css, type CSSResult } from 'lit';

const baseBadgeStyles: CSSResult = css`
  .badge {
    display: inline-block;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border-radius: var(--border-radius-medium);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium, 500);
  }
`;

const categoryBadgeStyles: CSSResult = css`
  .category-badge,
  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    background: var(--wa-color-neutral-fill-quiet);
    color: var(--wa-color-neutral-on-quiet);
  }

  .category-badge wa-icon,
  .agent-category-badge wa-icon {
    font-size: var(--font-size-sm);
  }
`;

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

/**
 * Tinted status badge — small pill with a tinted background.
 * Set `--_tint` on the element to control the color.
 *
 * Usage:
 *   <span class="tinted-badge" style="--_tint: var(--color-warning)">running</span>
 *
 * Or define a variant class:
 *   .my-badge--error { --_tint: var(--color-error); }
 */
export const tintedBadgeStyles: CSSResult = css`
  .tinted-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    padding: var(--border-thin) var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    color: var(--_tint, var(--color-text-secondary));
    background: color-mix(
      in srgb,
      var(--_tint, var(--color-text-secondary)) 12%,
      transparent
    );
    border-radius: var(--border-radius-small);
    white-space: nowrap;
  }

  .tinted-badge wa-icon {
    font-size: var(--font-size-xs);
  }
`;

export const badgeStyles: CSSResult[] = [
  baseBadgeStyles,
  categoryBadgeStyles,
  searchHighlightStyles,
  emptyStateStyles,
];
