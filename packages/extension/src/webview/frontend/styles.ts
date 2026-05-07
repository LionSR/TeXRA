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
    gap: var(--spacing-small);
    padding: 0 var(--spacing-tiny) var(--spacing-small);
    flex-shrink: 0;
  }

  .view-header vscode-tabs {
    flex: 1;
    min-width: 0;
    --panel-display: none;
  }

  .header-action {
    flex-shrink: 0;
  }

  .header-action::part(base) {
    min-height: var(--height-control, 24px);
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .file-selection-group {
    background-color: var(--background-color);
    border: var(--border-thin) solid
      var(--texra-widget-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--spacing-medium);
    margin-bottom: var(--spacing-large);
    overflow: visible;
  }

  .file-selection-group--disabled {
    display: none;
  }
`;
