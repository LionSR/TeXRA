/**
 * Shared dropdown menu styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - Dropdown container positioning
 * - Menu appearance and animations
 * - Menu items (checkboxes, options)
 * - Chevron rotation states
 *
 * Used by: FileSelectGroup, LatexDiffsSection, mainViewStyles
 *
 * @example
 * import { dropdownStyles } from '@shared/styles/dropdownStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, dropdownStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const dropdownStyles: CSSResult = css`
  /* Dropdown container - positions relative for absolute menu */
  .dropdown-container {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .dropdown-container vscode-toolbar-button {
    flex-shrink: 0;
  }

  /* Dropdown menu - appears below trigger */
  .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny, 2px));
    z-index: 100;
    display: block;
    background-color: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border);
    border-radius: var(--border-radius, 3px);
    min-width: 160px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  /* Hidden state */
  .dropdown-menu:not([show]) {
    display: none;
  }

  /* Menu content layout */
  .dropdown-menu-content {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--spacing-tiny, 2px);
  }

  /* Checkbox items in menu */
  .dropdown-menu vscode-checkbox {
    display: flex;
    align-items: center;
    height: 20px;
    padding: var(--spacing-tiny, 2px);
    font-size: var(--font-size-sm, 12px);
  }

  .dropdown-menu vscode-checkbox:hover {
    background: var(--vscode-list-hoverBackground);
  }

  /* Menu item base */
  .dropdown-menu-item {
    display: flex;
    align-items: center;
    gap: var(--spacing-small, 4px);
    padding: var(--spacing-small, 4px) var(--spacing-medium, 8px);
    cursor: pointer;
    font-size: var(--font-size-sm, 12px);
  }

  .dropdown-menu-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  /* Chevron rotation for expanded state */
  vscode-toolbar-button[aria-expanded='true'] .codicon-chevron-down {
    transform: rotate(180deg);
  }

  .chevron-icon {
    transition: transform 0.2s ease;
  }

  [aria-expanded='true'] .chevron-icon {
    transform: rotate(180deg);
  }
`;
