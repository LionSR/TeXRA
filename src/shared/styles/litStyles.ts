import { css, type CSSResult } from 'lit';

/**
 * Design tokens as CSS custom properties for shadow DOM components.
 */
export const designTokens: CSSResult = css`
  :host {
    /* Text colors */
    --color-text-secondary: var(--vscode-descriptionForeground);
    --color-text-link: var(--vscode-textLink-foreground);
    --color-text-link-active: var(--vscode-textLink-activeForeground);

    /* Background colors */
    --color-bg-secondary: var(--vscode-sideBar-background);

    /* Border colors */
    --color-border: var(--vscode-panel-border);

    /* Status colors */
    --color-success: var(--vscode-testing-iconPassed, #2ea043);
    --color-error: var(--vscode-editorError-foreground, #f14c4c);
    --color-warning: var(--vscode-editorWarning-foreground, #cca700);
    --color-added: var(--vscode-charts-green, #4caf50);
    --color-removed: var(--vscode-charts-red, #f44336);

    /* Component aliases */
    --background-color: var(--color-bg-secondary);
    --text-color: var(--vscode-sideBar-foreground);
    --button-hover-background: var(--vscode-button-hoverBackground);
    --dropdown-border: var(--vscode-dropdown-border);

    /* Typography */
    --font-size: var(--vscode-font-size);
    --font-family: var(--vscode-font-family);
    --font-weight: var(--vscode-font-weight);
    --font-size-lg: calc(var(--font-size) * 1.2);
    --font-size-sm: calc(var(--font-size) * 0.9);
    --font-size-xs: calc(var(--font-size) * 0.8);
    --font-size-icon: var(--font-size-lg);
    --font-size-icon-sm: var(--font-size);

    /* Spacing */
    --spacing-tiny: 2px;
    --spacing-small: 4px;
    --spacing-medium: 8px;
    --spacing-large: 12px;
    --spacing-xlarge: 20px;

    /* Border radius */
    --border-radius-small: 2px;
    --border-radius: 3px;
    --border-radius-large: 6px;

    /* Heights */
    --height-control: 24px;
    --height-button: 30px;
    --height-small: 100px;
    --height-medium: 200px;
    --height-large: 300px;
    --height-xlarge: 400px;
    --height-max: 1000px;

    /* Widths */
    --width-icon: 16px;
    --width-button-min: 80px;
    --width-dropdown: 160px;

    /* Borders */
    --border-thin: 1px;
    --border-medium: 2px;
    --border-thick: 3px;

    /* Opacity levels */
    --opacity-disabled: 0.5;
    --opacity-subtle: 0.7;
    --opacity-normal: 0.85;
    --opacity-full: 1;
  }
`;

/**
 * Shared animation keyframes.
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
