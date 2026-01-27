/**
 * Main view styles for MainApp component.
 *
 * These styles apply to MainApp's Shadow DOM template content.
 * Shared component styles are in styles/fileSelectStyles.ts.
 */

// Third-party imports
import { css, type CSSResult } from 'lit';

export const mainViewStyles: CSSResult = css`
  :host {
    background-color: transparent;
    color: var(--text-color);
    font-weight: var(--font-weight);
    min-height: 100vh;
    padding: var(--spacing-medium);
    display: flex;
    flex-direction: column;
  }

  @keyframes pulse-fade {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .file-selection-group {
    background-color: var(--background-color);
    border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--spacing-medium);
    margin-bottom: var(--spacing-large);
    overflow: visible;
  }

  .file-selection-group--disabled {
    display: none;
  }
`;
