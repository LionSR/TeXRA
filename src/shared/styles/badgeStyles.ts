import { css, type CSSResult } from 'lit';

export const baseBadgeStyles: CSSResult = css`
  .badge {
    display: inline-block;
    padding: var(--spacing-small) var(--spacing-medium);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  .badge--small {
    border-radius: var(--border-radius-small);
  }
`;

export const categoryBadgeStyles: CSSResult = css`
  .category-badge,
  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .category-badge .codicon,
  .agent-category-badge .codicon {
    font-size: var(--font-size-sm);
  }

  .category-workflow,
  .category-badge.workflow {
    background-color: var(
      --vscode-editorInfo-background,
      rgba(0, 127, 212, 0.15)
    );
    color: var(--vscode-editorInfo-foreground, #3794ff);
  }

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

export const badgeStyles = [
  baseBadgeStyles,
  categoryBadgeStyles,
  searchHighlightStyles,
  emptyStateStyles,
];
