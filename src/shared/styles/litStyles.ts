/**
 * Shared Lit styles for shadow DOM components.
 *
 * This module provides design tokens and common styles that mirror
 * the external CSS files (tokens.css, utilities.css) for use in
 * Lit components with shadow DOM encapsulation.
 *
 * @example
 * import { designTokens, utilityStyles } from '@shared/styles/litStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, utilityStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

/**
 * Design tokens as CSS custom properties.
 * These mirror the values in tokens.css for shadow DOM use.
 */
export const designTokens: CSSResult = css`
  :host {
    /* Spacing - consistent spacing scale */
    --spacing-tiny: 4px;
    --spacing-small: 8px;
    --spacing-medium: 12px;
    --spacing-large: 16px;
    --spacing-xlarge: 24px;

    /* Heights - control and content heights */
    --height-control: 26px;
    --height-large: 200px;
    --height-xlarge: 400px;

    /* Typography */
    --font-size: 13px;
    --font-size-sm: 12px;
    --font-size-xs: 11px;
    --font-size-icon: 16px;
    --font-size-icon-sm: 14px;
    --font-family: var(--vscode-font-family, sans-serif);

    /* Borders */
    --border-thin: 1px;
    --border-radius-small: 2px;
    --border-radius-medium: 4px;
    --border-radius-large: 6px;

    /* Colors - semantic colors using VS Code variables */
    --color-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    --color-success: var(--vscode-charts-green, #4caf50);
    --color-error: var(--vscode-errorForeground, #f44336);
    --color-warning: var(--vscode-editorWarning-foreground, #ff9800);
    --color-text-secondary: var(--vscode-descriptionForeground, #717171);
    --background-color: var(--vscode-editor-background, #1e1e1e);

    /* Opacity - consistent opacity scale */
    --opacity-subtle: 0.7;
    --opacity-disabled: 0.5;
    --opacity-full: 1;
  }
`;

/**
 * Common utility styles for shadow DOM components.
 */
export const utilityStyles: CSSResult = css`
  /* Hidden utility */
  [hidden] {
    display: none !important;
  }

  /* Visually hidden but accessible */
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Truncate text with ellipsis */
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Flex utilities */
  .flex {
    display: flex;
  }
  .flex-col {
    flex-direction: column;
  }
  .flex-1 {
    flex: 1;
  }
  .items-center {
    align-items: center;
  }
  .justify-between {
    justify-content: space-between;
  }
  .gap-small {
    gap: var(--spacing-small);
  }
  .gap-medium {
    gap: var(--spacing-medium);
  }
`;

/**
 * Animation keyframes commonly used across components.
 */
export const animationStyles: CSSResult = css`
  @keyframes pulse-scale {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.15);
      opacity: 0.8;
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .spin {
    animation: spin 1s linear infinite;
  }
`;
