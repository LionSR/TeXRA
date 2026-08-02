/** Component-scoped styles for {@link FileList} (generated-files listing). */

import { css, type CSSResult } from 'lit';

export const fileListStyles: CSSResult = css`
  :host {
    display: block;
  }

  :host([hidden]) {
    display: none;
  }

  .files-container {
    padding: 0;
    font-size: var(--wa-editor-font-size);
    overflow-y: auto;
    max-height: var(--height-large);
    flex-shrink: 0;
  }

  .storage-hint {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-3xs) 0 var(--wa-space-2xs);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: 1.4;
  }

  .storage-hint wa-icon {
    flex-shrink: 0;
  }

  .storage-hint__text {
    flex: 1;
    min-width: 0;
  }

  .storage-hint__dismiss {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    padding: var(--wa-space-3xs) 0;
    margin-bottom: 0;
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 200px;
  }

  .file-path {
    cursor: pointer;
  }

  .file-path:hover {
    text-decoration: underline;
  }

  .file-dir {
    opacity: var(--opacity-subtle);
    font-size: var(--font-size-sm);
  }

  .file-basename {
    font-weight: var(--font-weight-medium);
  }

  .file-stats {
    white-space: nowrap;
    text-decoration: none;
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .file-stats span:first-child {
    margin-left: 0;
  }

  .added {
    color: var(--wa-color-chart-green, green);
    margin-left: var(--wa-space-2xs);
    font-size: var(--font-size-sm);
  }

  .removed {
    color: var(--wa-color-chart-red, red);
    margin-left: var(--wa-space-2xs);
    font-size: var(--font-size-sm);
  }

  .file-actions {
    display: flex;
    gap: var(--wa-space-3xs);
    flex-shrink: 0;
    flex-wrap: nowrap;
    align-items: center;
  }

  .file-actions wa-button {
    margin-right: 0;
    margin-left: var(--wa-space-3xs);
  }

  /* Nested round collapsibles inherit the shared .panel-collapsible
     chrome; they only drop the top rule on the first round (the parent
     panel already rules above it) and shrink the header text so the
     nested rounds read as subordinate. */
  .round-collapsible:first-child {
    border-top: none;
  }

  .round-collapsible::part(header) {
    font-size: var(--font-size-sm);
  }

  .compile-warning {
    flex-shrink: 0;
    color: var(--color-warning);
  }

  .compile-actions {
    display: flex;
    justify-content: flex-end;
    padding: var(--wa-space-2xs) 0;
    border-top: var(--border-thin) solid var(--color-border);
    margin-top: var(--wa-space-3xs);
  }

  @media (max-width: 500px) {
    .file-item {
      flex-wrap: wrap;
      gap: var(--wa-space-2xs);
      align-items: center;
    }

    .file-name {
      width: 100%;
      flex-basis: 100%;
    }

    .file-actions {
      margin-left: auto;
    }
  }
`;
