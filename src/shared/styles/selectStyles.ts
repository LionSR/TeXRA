/**
 * Shared select/dropdown styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - Select group layouts with icons
 * - vscode-single-select components
 * - vscode-option states (disabled, tool-use, requires-key)
 * - Codicon icon styling in select contexts
 *
 * @example
 * import { selectStyles } from '@shared/styles/selectStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, selectStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const selectStyles: CSSResult = css`
  /* Select group layout - icon + dropdown combo */
  .select-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-tiny);
  }

  .select-group .codicon {
    margin-right: var(--spacing-small);
    color: var(--text-color, var(--vscode-foreground));
    vertical-align: text-bottom;
  }

  .select-group vscode-single-select {
    flex: 1;
    min-width: 6rem;
    max-width: 10rem;
  }

  /* Agent select specific widths */
  .agent-select-controls {
    flex: 1;
    min-width: 10rem;
    max-width: 14rem;
  }

  .agent-select-dropdowns {
    position: relative;
    width: 100%;
    min-width: 10rem;
    max-width: 14rem;
  }

  /* vscode-option base styling */
  vscode-option {
    font-family: var(--vscode-font-family);
  }

  /* Disabled/unavailable option states */
  vscode-option.disabled-option,
  vscode-option.disabled-model,
  vscode-option.disabled-agent,
  vscode-option[data-requires-key='true'] {
    color: var(--color-text-secondary, var(--vscode-descriptionForeground));
    opacity: var(--opacity-subtle, 0.7);
    font-style: italic;
  }

  /* Tool-use indicator */
  vscode-option[data-tool-use='true'] {
    font-style: italic;
  }

  /* Clickable icon states */
  .clickable {
    cursor: pointer;
  }

  .clickable:hover {
    color: var(--vscode-foreground);
  }

  .codicon.clickable:hover {
    color: var(--button-hover-background, var(--vscode-button-hoverBackground));
  }

  /* Listbox max-height constraint for long lists */
  vscode-single-select::part(listbox) {
    max-height: var(--height-large, 300px);
  }

  /* API key missing indicator in model options */
  .api-key-missing {
    color: var(--vscode-errorForeground);
    opacity: 1;
    font-style: normal;
    margin-left: var(--spacing-tiny);
  }
`;
