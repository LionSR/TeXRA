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
import { compactFormControlStyles } from '@shared/styles';
import { buttonStyles } from '@shared/styles/controlStyles';

/** Core file-select layout styles. */
export const fileSelectLayoutStyles = css`
  .file-select {
    margin-bottom: var(--wa-space-xs);
  }

  .file-select-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--wa-space-3xs);
    flex-wrap: nowrap;
    line-height: var(--line-height-normal);
    gap: var(--wa-space-2xs);
    min-height: var(--height-control-compact);
  }

  .file-select-header > wa-button {
    opacity: var(--opacity-full);
    flex-shrink: 0;
  }

  .file-select label,
  .file-select-label {
    display: block;
    margin-bottom: var(--wa-space-3xs);
    font-size: var(--font-size);
  }

  .file-select-label-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex-wrap: nowrap;
    flex: 1;
    min-width: 0;
    min-height: var(--height-control-compact);
  }

  .file-select-label-group wa-button {
    opacity: var(--opacity-full);
  }

  .file-select-label-group wa-input {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .file-select-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--height-control-compact);
    height: var(--height-control-compact);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .file-select-count {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .file-select-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-wrap: nowrap;
    margin-inline-start: auto;
    gap: var(--wa-space-2xs);
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

/** Multiple files list styles. */
const multiFilesStyles = css`
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

  .file-item:hover {
    background-color: var(--wa-color-list-hover-bg);
  }

  /* Truncation lives on the .file-name-main / .file-folder children — this is
     a flex column, where text-overflow has no effect. */
  .file-name {
    overflow: hidden;
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
    font-size: var(--font-size-sm);
  }

  .file-folder wa-icon {
    font-size: var(--font-size-xs);
    margin-inline-end: var(--wa-space-3xs);
  }

  /* .move-button / .remove-button are wa-button.action-icon-button now; sizing
     comes from buttonStyles. Only the per-row layout shrink survives here. */
  .move-button,
  .remove-button {
    flex-shrink: 0;
  }

  .file-list-placeholder {
    color: var(--color-text-secondary);
    font-style: italic;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
  }
`;

/** Outline cue for the file-select button when document options are active.
 *  (The dropdown itself is a native <wa-dropdown>.) */
const dropdownStyles = css`
  wa-button.has-options::part(base) {
    outline: var(--border-thin) solid
      var(--wa-color-brand-border-quiet, var(--wa-color-focus));
    outline-offset: -1px;
  }
`;

/** Combined file-select styles for components that need all of them. */
export const fileSelectStyles = [
  buttonStyles,
  compactFormControlStyles,
  fileSelectLayoutStyles,
  multiFilesStyles,
  dropdownStyles,
];
