/**
 * Shared file-select styles for MainView components.
 *
 * These styles are used by:
 * - FileSelectGroup
 * - OutputFilesSection
 * - LatexDiffsSection
 *
 * Consolidating them here prevents duplication across Shadow DOM components.
 */

import { css } from 'lit';

/** Core file-select layout styles. */
export const fileSelectLayoutStyles = css`
  .file-select {
    margin-bottom: var(--spacing-large);
  }

  .file-select:has(.optional-label) {
    margin-bottom: var(--spacing-tiny);
  }

  .file-select-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-small);
    flex-wrap: nowrap;
    line-height: var(--line-height-relaxed);
    gap: var(--spacing-small);
  }

  .file-select-header > vscode-toolbar-button {
    opacity: var(--opacity-full);
    flex-shrink: 0;
  }

  .file-select-header label {
    margin-right: var(--spacing-small);
  }

  .file-select label {
    display: block;
    margin-bottom: var(--spacing-tiny);
    font-size: var(--font-size);
  }

  .file-select-label-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex-wrap: nowrap;
    flex: 1;
    min-width: 0;
    min-height: var(--height-control);
  }

  .file-select-label-group vscode-toolbar-button {
    opacity: var(--opacity-full);
  }

  .file-select-label-group vscode-textfield {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .file-select-label-group label {
    margin-right: var(--spacing-small);
  }

  .file-select-hint {
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
    min-width: 0;
  }

  .file-select-actions,
  vscode-toolbar-container.file-select-actions {
    flex-direction: column !important;
    flex-wrap: nowrap;
    margin-left: auto;
  }

  .file-select-actions vscode-toolbar-button {
    opacity: var(--opacity-full);
    width: var(--height-control);
    height: var(--height-control);
    min-width: var(--height-control);
    min-height: var(--height-control);
  }

  .file-select select,
  .file-select vscode-single-select {
    width: 100%;
  }

  .file-select:not([data-expanded='true']) .file-action-button {
    display: none;
  }
`;

/** Toggle icon and optional label styles. */
export const toggleStyles = css`
  .optional-label {
    color: var(--text-color);
    font-weight: normal;
    font-size: var(--font-size);
    white-space: nowrap;
    min-width: calc(var(--width-button-min) * 2);
    display: flex;
    align-items: center;
    height: var(--height-control);
  }

  .toggle-icon {
    cursor: pointer;
    user-select: none;
    margin: 0;
    position: relative;
    padding: 0 var(--spacing-tiny);
    color: var(--text-color);
    display: flex;
    align-items: center;
    height: var(--height-control);
    background: none;
    border: none;
  }

  .toggle-icon:focus-visible {
    outline: var(--border-thin) solid var(--texra-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .file-select[data-expanded='true'] .optional-label,
  .file-select[data-expanded='true'] .toggle-icon {
    color: var(--texra-foreground);
  }
`;

/** Multiple files list styles. */
export const multiFilesStyles = css`
  .multiple-files-container {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-top: var(--spacing-small);
    padding: 0;
  }

  .multiple-files-content {
    width: 100%;
    padding: 0;
  }

  .multiple-files-list {
    background-color: var(--background-color);
    border: var(--border-thin) solid
      var(--texra-widget-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--spacing-small);
    font-size: var(--font-size);
    max-height: var(--height-small);
    overflow-y: auto;
  }

  .file-item {
    padding: var(--spacing-tiny) var(--spacing-small);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-radius: var(--border-radius-small);
    transition: background-color var(--transition-fast);
  }

  .file-item:hover {
    background-color: var(--texra-list-hoverBackground);
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .remove-button {
    color: var(--texra-icon-foreground, var(--texra-foreground));
    cursor: pointer;
    flex-shrink: 0;
    opacity: var(--opacity-subtle);
    background: none;
    border: none;
    padding: 0;
    display: inline-flex;
    align-items: center;
    transition: opacity var(--transition-fast);
  }

  .remove-button:hover {
    opacity: var(--opacity-full);
  }

  .remove-button:focus-visible {
    opacity: var(--opacity-full);
    outline: var(--border-thin) solid var(--texra-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .file-list-placeholder {
    color: var(--color-text-secondary);
    font-style: italic;
    padding: var(--spacing-tiny) var(--spacing-small);
  }
`;

/** Dropdown menu styles. */
export const dropdownStyles = css`
  .dropdown-container {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .dropdown-container vscode-toolbar-button {
    flex-shrink: 0;
  }

  .dropdown-container vscode-toolbar-button.has-options::part(control) {
    box-shadow: inset 0 0 0 1px
      var(--texra-inputValidation-infoBorder, var(--texra-focusBorder));
  }

  .dropdown-container .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    left: 0;
    right: auto;
    z-index: 100;
    display: block;
    background-color: var(--texra-menu-background);
    color: var(--texra-menu-foreground);
    border: var(--border-thin) solid var(--texra-menu-border);
    border-radius: var(--border-radius);
    min-width: 160px;
  }

  .dropdown-container .dropdown-menu:not([show]) {
    display: none;
  }

  .dropdown-container .dropdown-menu .dropdown-menu-content {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--spacing-tiny);
  }

  .dropdown-container .dropdown-menu vscode-checkbox {
    display: flex;
    align-items: center;
    height: 20px;
    padding: var(--spacing-tiny);
    font-size: var(--font-size-sm);
  }

  .dropdown-container .dropdown-menu vscode-checkbox {
    transition: background-color var(--transition-fast);
  }

  .dropdown-container .dropdown-menu vscode-checkbox:hover {
    background: var(--texra-list-hoverBackground);
  }
`;

/** Combined file-select styles for components that need all of them. */
export const fileSelectStyles = [
  fileSelectLayoutStyles,
  toggleStyles,
  multiFilesStyles,
  dropdownStyles,
];
