/**
 * Shared file-select styles for MainView components.
 *
 * These styles are used by:
 * - FileSelectGroup
 * - LatexDiffsSection
 *
 * Consolidating them here prevents duplication across Shadow DOM components.
 */

import { css } from 'lit';
import {
  compactFormControlStyles,
  compactIconActionButtonStyles,
} from '@shared/styles';

/**
 * Re-exported under the legacy names so existing imports keep working. The
 * canonical definitions live in `@shared/styles/selectStyles` and
 * `@shared/styles/commonViewStyles`; importing from here keeps file-select
 * components from having to pull the full common view / select sheets.
 */
export const compactActionButtonStyles = compactIconActionButtonStyles;
export { compactFormControlStyles };

/** Core file-select layout styles. */
export const fileSelectLayoutStyles = css`
  .file-select {
    margin-bottom: var(--wa-space-3xs);
  }

  .file-select-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--wa-space-3xs);
    flex-wrap: nowrap;
    line-height: var(--line-height-normal);
    gap: var(--wa-space-2xs);
    min-height: 22px;
  }

  .file-select-header > wa-button {
    opacity: var(--opacity-full);
    flex-shrink: 0;
  }

  .file-select-header label {
    margin-right: var(--wa-space-2xs);
  }

  .file-select label {
    display: block;
    margin-bottom: var(--wa-space-3xs);
    font-size: var(--font-size);
  }

  .file-select-label-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    flex-wrap: nowrap;
    flex: 1;
    min-width: 0;
    min-height: 22px;
  }

  .file-select-label-group wa-button {
    opacity: var(--opacity-full);
  }

  .file-select-label-group wa-input {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .file-select-label-group label {
    margin-right: var(--wa-space-2xs);
  }

  .file-select-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
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

  .file-select-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-wrap: nowrap;
    margin-left: auto;
    gap: var(--wa-space-3xs);
  }

  .file-select-actions wa-button {
    opacity: var(--opacity-full);
    flex-shrink: 0;
  }

  .file-select select,
  .file-select wa-select {
    width: 100%;
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
    height: 22px;
  }

  .toggle-icon {
    cursor: pointer;
    user-select: none;
    margin: 0;
    position: relative;
    padding: 0 var(--wa-space-3xs);
    color: var(--text-color);
    display: flex;
    align-items: center;
    height: 22px;
    background: none;
    border: none;
  }

  .toggle-icon:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }
`;

/** Multiple files list styles. */
export const multiFilesStyles = css`
  .multiple-files-container {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-top: var(--wa-space-3xs);
    padding: 0;
  }

  .multiple-files-content {
    width: 100%;
    padding: 0;
  }

  .multiple-files-list {
    background-color: var(--background-color);
    border: var(--border-thin) solid
      var(--wa-color-surface-border, var(--dropdown-border));
    border-radius: var(--border-radius);
    padding: var(--wa-space-2xs);
    font-size: var(--font-size);
    max-height: var(--height-small);
    overflow-y: auto;
  }

  .file-item {
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-radius: var(--border-radius-small);
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .file-name-main,
  .file-folder {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-name-main {
    color: var(--wa-color-text-normal);
  }

  .file-folder {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .file-folder wa-icon {
    font-size: var(--font-size-xs);
    margin-right: var(--wa-space-3xs);
  }

  /* .remove-button is a wa-button.action-icon-button now; sizing comes from
     compactActionButtonStyles. Only the per-row layout shrink survives here. */
  .remove-button {
    flex-shrink: 0;
  }

  .file-list-placeholder {
    color: var(--color-text-secondary);
    font-style: italic;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
  }
`;

/** Dropdown menu styles. */
export const dropdownStyles = css`
  .dropdown-container {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .dropdown-container wa-button {
    flex-shrink: 0;
  }

  wa-button.has-options::part(base) {
    outline: var(--border-thin) solid
      var(--wa-color-brand-border-quiet, var(--wa-color-focus));
    outline-offset: -1px;
  }

  .dropdown-container .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--wa-space-3xs));
    left: 0;
    right: auto;
    z-index: 100;
    display: block;
    background-color: var(--wa-color-menu-background);
    color: var(--wa-color-menu-foreground);
    border: var(--border-thin) solid var(--wa-color-menu-border);
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
    padding: var(--wa-space-3xs);
  }

  .dropdown-container .dropdown-menu wa-checkbox {
    display: flex;
    align-items: center;
    height: 20px;
    padding: var(--wa-space-3xs);
    font-size: var(--font-size-sm);
  }

  .dropdown-container .dropdown-menu wa-checkbox:hover {
    background: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 30%,
      transparent
    );
  }
`;

/** Combined file-select styles for components that need all of them. */
export const fileSelectStyles = [
  compactActionButtonStyles,
  compactFormControlStyles,
  fileSelectLayoutStyles,
  toggleStyles,
  multiFilesStyles,
  dropdownStyles,
];
