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
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: 0 var(--wa-space-3xs) var(--wa-space-2xs);
    flex-shrink: 0;
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .file-selection {
    margin-bottom: var(--wa-space-s);
  }

  .file-selection-heading {
    margin: 0;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    min-height: var(--height-control-compact);
    box-sizing: border-box;
    font-size: var(--font-size-sm);
    font-weight: var(--wa-font-weight-normal);
    color: var(--wa-color-text-normal);
  }

  .file-selection-group {
    background: transparent;
    border: none;
    padding: var(--wa-space-2xs) 0 0;
    margin: 0;
    overflow: visible;
  }
`;
