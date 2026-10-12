import { css, type CSSResult } from 'lit';

export const settingsCatalogStyles: CSSResult = css`
  :host {
    display: block;
    container: settings-catalog / inline-size;
  }

  .catalog-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 8.5rem auto;
    align-items: end;
    gap: var(--wa-space-xs);
    margin-block-end: var(--wa-space-xs);
  }
  .catalog-toolbar > * {
    min-width: 0;
  }
  .catalog-panel {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    height: var(--catalog-height, clamp(14rem, calc(100dvh - 24rem), 28rem));
    overflow: hidden;
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-default);
  }
  .catalog-list {
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-inline-end: var(--border-thin) solid var(--color-border);
  }
  .catalog-group {
    position: sticky;
    top: 0;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 3.5rem;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    background: var(--wa-color-surface-default);
  }
  .catalog-group-count {
    margin-inline-start: var(--wa-space-2xs);
    font-variant-numeric: tabular-nums;
  }
  .catalog-group > :last-child {
    text-align: center;
  }
  .catalog-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 3.5rem;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding-inline: var(--wa-space-xs);
    color: var(--wa-color-text-normal);
  }
  .catalog-row:hover {
    background: var(--surface-hover);
  }
  .catalog-row.selected {
    background: var(--surface-selected);
  }
  .catalog-row-select {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    min-width: 0;
    padding: var(--wa-space-2xs) 0;
    border: 0;
    border-radius: var(--border-radius-small);
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .catalog-row-text {
    display: grid;
    gap: var(--wa-space-3xs);
    min-width: 0;
    flex: 1;
  }
  .catalog-row-name,
  .catalog-row-description {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .catalog-row-name {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
  }
  .catalog-row-description {
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
  }
  .catalog-row-badges {
    display: flex;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
  }
  .catalog-row-toggle {
    justify-self: center;
  }
  .catalog-row-toggle[aria-pressed='false'] {
    color: var(--color-text-secondary);
  }

  .catalog-actions {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }
  .catalog-row-control {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
  }
  .catalog-row-toggle[aria-pressed]::part(base) {
    background: transparent;
  }
  .catalog-row-toggle[aria-pressed]::part(base):hover {
    background: var(--surface-hover);
  }
  .catalog-row-status {
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
  }
  .catalog-detail {
    container: settings / inline-size;
    min-width: 0;
    overflow-y: auto;
    padding: var(--wa-space-s);
  }
  .catalog-count {
    padding-block-start: var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }
  .catalog-empty {
    margin: 0;
    padding: var(--wa-space-xs);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  @container settings-catalog (max-width: 560px) {
    .catalog-toolbar {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .catalog-search {
      grid-column: 1 / -1;
    }
    .catalog-panel {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
    }
    .catalog-list {
      max-height: 18rem;
      border-inline-end: 0;
      border-block-end: var(--border-thin) solid var(--color-border);
    }
    .catalog-detail {
      max-height: 24rem;
    }
  }
`;
