/**
 * Shared optional label styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - Optional/toggle labels in file selection areas
 * - Expanded/collapsed state indicators
 * - Toggle icons
 *
 * Used by: FileSelectGroup, LatexDiffsSection, OutputFilesSection
 *
 * @example
 * import { optionalLabelStyles } from '@shared/styles/optionalLabelStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, optionalLabelStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const optionalLabelStyles: CSSResult = css`
  /* Optional label - used for toggleable sections */
  .optional-label {
    color: var(--text-color, var(--vscode-foreground));
    font-weight: normal;
    font-size: var(--font-size, 13px);
    white-space: nowrap;
    min-width: calc(var(--width-button-min, 80px) * 2);
    display: flex;
    align-items: center;
    height: var(--height-control, 24px);
  }

  /* Toggle icon for expandable sections */
  .toggle-icon {
    cursor: pointer;
    user-select: none;
    margin: 0;
    position: relative;
    padding: 0 var(--spacing-tiny, 2px);
    color: var(--text-color, var(--vscode-foreground));
    display: flex;
    align-items: center;
    height: var(--height-control, 24px);
  }

  /* Expanded state - highlight label and toggle */
  [data-expanded='true'] .optional-label,
  [data-expanded='true'] .toggle-icon {
    color: var(--vscode-foreground);
  }

  /* File select specific spacing */
  .file-select:has(.optional-label) {
    margin-bottom: var(--spacing-tiny, 2px);
  }

  .file-select[data-expanded='true'] .optional-label {
    color: var(--vscode-foreground);
  }

  /* Header toolbar button visibility */
  .file-select-header > vscode-toolbar-button {
    opacity: 1;
    flex-shrink: 0;
  }

  /* Textfield in label groups */
  .file-select-label-group vscode-textfield {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
`;
