// Third-party imports
import { css, type CSSResult } from 'lit';

/**
 * Shared badge styles for category and status indicators.
 *
 * Used by:
 * - HistoryView (agent category badges)
 * - ProfileView (category, visibility, tier badges)
 * - ProgressView (status indicators)
 */

/** Base badge styles - foundation for all badge types */
export const baseBadgeStyles: CSSResult = css`
  .badge {
    display: inline-block;
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  .badge--small {
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius-small);
  }
`;

/** Agent category badge styles (workflow vs tool-use) */
export const categoryBadgeStyles: CSSResult = css`
  .category-badge,
  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
    /* Base styling for unknown categories */
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .category-badge .codicon,
  .agent-category-badge .codicon {
    font-size: var(--font-size-sm);
  }

  /* Workflow category - blue tones */
  .category-workflow,
  .category-badge.workflow {
    background-color: var(
      --vscode-editorInfo-background,
      rgba(0, 127, 212, 0.15)
    );
    color: var(--vscode-editorInfo-foreground, #3794ff);
  }

  /* Tool-use category - yellow/amber tones */
  .category-tool-use,
  .category-badge.tooluse,
  .category-badge.tool-use {
    background-color: var(
      --vscode-editorWarning-background,
      rgba(255, 204, 0, 0.15)
    );
    color: var(--vscode-editorWarning-foreground, #cca700);
  }
`;

/** Search highlight mark styles */
export const searchHighlightStyles: CSSResult = css`
  mark {
    background-color: var(
      --vscode-editor-findMatchHighlightBackground,
      #ffef0b80
    );
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    padding: 0;
    border-radius: var(--border-radius-small);
  }

  mark[data-current='true'] {
    background-color: var(--vscode-editor-findMatchBackground, #ff8b0088);
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }
`;

/** Empty/placeholder state styles */
export const emptyStateStyles: CSSResult = css`
  .empty-state,
  .no-data,
  .no-agents,
  .history-none {
    color: var(--color-text-secondary);
    font-style: italic;
    text-align: center;
    padding: var(--spacing-xlarge);
  }

  .loading {
    color: var(--color-text-secondary);
    font-style: italic;
  }
`;

/** Combined badge styles for components needing all badge functionality */
export const badgeStyles = [
  baseBadgeStyles,
  categoryBadgeStyles,
  searchHighlightStyles,
  emptyStateStyles,
];
