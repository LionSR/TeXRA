import { css, type CSSResult } from 'lit';

export const designTokens: CSSResult = css`
  :host {
    /* Text colors */
    --color-text-secondary: var(--texra-descriptionForeground);
    --color-text-link: var(--texra-textLink-foreground);
    --color-text-link-active: var(--texra-textLink-activeForeground);

    /* Background colors */
    --color-bg-secondary: var(--texra-sideBar-background);

    /* Border colors */
    --color-border: var(--texra-panel-border);

    /* Status colors */
    --color-success: var(--texra-testing-iconPassed, #2ea043);
    --color-error: var(--texra-editorError-foreground, #f14c4c);
    --color-warning: var(--texra-editorWarning-foreground, #cca700);
    --color-info: var(--texra-charts-blue, #3794ff);
    --color-added: var(--texra-charts-green, #4caf50);
    --color-removed: var(--texra-charts-red, #f44336);

    /* Component aliases */
    --background-color: var(--color-bg-secondary);
    --text-color: var(--texra-sideBar-foreground);
    --button-hover-background: var(--texra-button-hoverBackground);
    --dropdown-border: var(--texra-dropdown-border);

    /* Typography */
    --font-size: var(--texra-font-size);
    --font-family: var(--texra-font-family);
    --font-weight: var(--texra-font-weight);
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --font-size-lg: calc(var(--font-size) * 1.2);
    --font-size-sm: calc(var(--font-size) * 0.9);
    --font-size-xs: calc(var(--font-size) * 0.8);
    --font-size-icon: var(--font-size-lg);
    --font-size-icon-sm: var(--font-size);
    --line-height-tight: 1;
    --line-height-heading: 1.25;
    --line-height-normal: 1.4;
    --line-height-relaxed: 1.5;

    /* Spacing */
    --spacing-tiny: 2px;
    --spacing-small: 4px;
    --spacing-medium: 8px;
    --spacing-large: 12px;
    --spacing-xlarge: 20px;

    /* Border radius */
    --border-radius-small: 2px;
    --border-radius: 3px;
    --border-radius-medium: 4px;
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
    --opacity-separator: 0.3;
    --opacity-disabled: 0.5;
    --opacity-subtle: 0.7;
    --opacity-hover: 0.8;
    --opacity-normal: 0.85;
    --opacity-full: 1;

    /* Transitions */
    --transition-fast: 0.15s ease;
    --transition-normal: 0.2s ease;
    --transition-slow: 0.3s ease;
  }
`;

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
    animation: spin 2s linear infinite;
  }
`;
