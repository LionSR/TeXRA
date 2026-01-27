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
    line-height: 1.5;
    gap: var(--spacing-small);
  }

  .file-select-header > vscode-toolbar-button {
    opacity: 1;
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
    opacity: 1;
  }

  .file-select-label-group vscode-textfield {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .file-select-label-group label {
    margin-right: var(--spacing-small);
  }

  .file-select-actions,
  vscode-toolbar-container.file-select-actions {
    flex-direction: column !important;
    flex-wrap: nowrap;
    margin-left: auto;
  }

  .file-select-actions vscode-toolbar-button {
    opacity: 1;
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
  }

  .file-select[data-expanded='true'] .optional-label,
  .file-select[data-expanded='true'] .toggle-icon {
    color: var(--vscode-foreground);
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
    border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
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
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .remove-button {
    color: var(--vscode-errorForeground);
    cursor: pointer;
    flex-shrink: 0;
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

  .dropdown-container .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    left: 0;
    right: auto;
    z-index: 100;
    display: block;
    background-color: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border);
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

  .dropdown-container .dropdown-menu vscode-checkbox:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;

/** Combined file-select styles for components that need all of them. */
export const fileSelectStyles = [
  fileSelectLayoutStyles,
  toggleStyles,
  multiFilesStyles,
  dropdownStyles,
];
