/** Component-scoped styles for {@link FileList} (generated-files listing). */

import { css, type CSSResult } from 'lit';
import { truncateDeclarations } from '@ui/styles/commonViewStyles';

export const fileListStyles: CSSResult = css`
  :host {
    display: block;
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
    line-height: var(--line-height-normal);
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

  .file-round-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .file-name {
    ${truncateDeclarations}
    flex: 1;
    min-width: 200px;
  }

  .file-dir {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .file-basename {
    font-weight: var(--font-weight-medium);
  }

  .file-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    flex-shrink: 0;
    flex-wrap: nowrap;
    align-items: center;
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

  .round-alert {
    flex-shrink: 0;
    color: var(--tone-color);
  }

  .compile-actions {
    display: flex;
    justify-content: flex-end;
    padding: var(--wa-space-2xs) 0;
    border-top: var(--border-thin) solid var(--color-border);
    margin-top: var(--wa-space-3xs);
  }

  @container (max-width: 500px) {
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
      margin-inline-start: auto;
    }
  }
`;
