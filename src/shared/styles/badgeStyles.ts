/**
 * Shared badge styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - Base badge component
 * - Badge size variants (small)
 * - Category badges (workflow, tool-use)
 * - Visibility badges (public, custom)
 * - Tier badges (free, max, ultra)
 *
 * Used by: HistoryItem, AgentsTable, ProfileInfo
 *
 * @example
 * import { badgeStyles } from '@shared/styles/badgeStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, badgeStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const badgeStyles: CSSResult = css`
  /* Base badge */
  .badge {
    display: inline-block;
    padding: var(--spacing-tiny, 2px) var(--spacing-small, 4px);
    border-radius: var(--border-radius, 3px);
    font-size: var(--font-size-sm, 12px);
    font-weight: 500;
  }

  /* Small badge variant */
  .badge--small {
    padding: var(--spacing-tiny, 2px) var(--spacing-small, 4px);
    border-radius: var(--border-radius-small, 2px);
  }

  /* Category badges with icon support */
  .category-badge,
  .agent-category-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small, 4px);
  }

  .agent-category-badge .codicon {
    font-size: var(--font-size-sm, 12px);
  }

  /* Workflow category - blue accent */
  .category-workflow {
    background-color: var(
      --vscode-editorInfo-background,
      rgba(0, 127, 212, 0.15)
    );
    color: var(--vscode-editorInfo-foreground, #3794ff);
  }

  /* Tool-use category - yellow/orange accent */
  .category-tool-use {
    background-color: var(
      --vscode-editorWarning-background,
      rgba(255, 204, 0, 0.15)
    );
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  /* Visibility badges */
  .visibility-badge.public {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-button-foreground);
  }

  .visibility-badge.custom {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  /* Tier badges */
  .tier-badge {
    text-transform: uppercase;
    font-weight: 600;
  }

  .tier-badge.free {
    background: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground);
  }

  .tier-badge.max {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .tier-badge.ultra {
    background: linear-gradient(
      135deg,
      var(--vscode-textLink-foreground) 0%,
      var(--vscode-textLink-activeForeground) 100%
    );
    color: var(--vscode-button-foreground);
  }
`;
