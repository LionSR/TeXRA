import { css, type CSSResult } from 'lit';

export const designTokens: CSSResult = css`
  :host {
    /* Text colors */
    --color-text-secondary: var(--wa-color-text-quiet);
    --color-text-link: var(--wa-color-text-link);
    --color-text-link-active: var(--wa-color-text-link-active);

    /* Background colors */
    --color-bg-secondary: var(--wa-color-surface-lowered);

    /* Border colors */
    --color-border: var(--wa-color-surface-border);

    /* Status colors */
    --color-success: var(--wa-color-success-on-quiet, #2ea043);
    --color-error: var(--wa-color-danger-on-quiet, #f14c4c);
    --color-warning: var(--wa-color-warning-on-quiet, #cca700);
    --color-info: var(--wa-color-chart-blue, #3794ff);
    --color-added: var(--wa-color-chart-green, #4caf50);
    --color-removed: var(--wa-color-chart-red, #f44336);

    /* Component aliases */
    --background-color: var(--color-bg-secondary);
    --text-color: var(--wa-color-text-normal);
    --button-hover-background: var(--wa-color-button-hover);
    --dropdown-border: var(--wa-form-control-border-color);

    /* Typography */
    --font-size: var(--wa-font-size-m);
    --font-family: var(--wa-font-family-body);
    --font-weight: var(--wa-font-weight-normal);
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --font-size-lg: calc(var(--font-size) * 1.2);
    --font-size-sm: calc(var(--font-size) * 0.9);
    --font-size-xs: calc(var(--font-size) * 0.8);
    --font-size-icon: var(--font-size-lg);
    --font-size-icon-sm: var(--font-size);

    /* Heading scale shared with desktop themeTokens.css. Use these tokens
       instead of hardcoded heading sizes so extension and desktop hosts
       render headings at the same visual scale. */
    --font-size-h1: 1.5em;
    --font-size-h2: 1.25em;
    --font-size-h3: 1em;
    --line-height-tight: 1;
    --line-height-heading: 1.25;
    --line-height-normal: 1.4;
    --line-height-relaxed: 1.5;

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
