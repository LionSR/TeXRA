import { css, type CSSResult } from 'lit';

/**
 * Compact wa-input / wa-select sizing — stricter IDE-density form controls.
 * WA defaults to ~38px tall; reduce to ~22px to match minimal VS Code chrome.
 *
 * Exported as a focused subset so file-select / main-view components can pull
 * just the form-control rules without inheriting the full select sheet.
 * `selectStyles` below interpolates this block to keep a single source of
 * truth for the selectors.
 */
export const compactFormControlStyles: CSSResult = css`
  wa-select {
    font-size: var(--font-size-sm);
  }

  wa-select::part(combobox) {
    min-height: 22px;
    min-width: 0;
    padding-block: 0;
    padding-inline: 6px;
    border: var(--border-thin) solid
      var(--wa-color-surface-border, var(--color-border));
  }

  wa-select::part(display-input) {
    padding-block: 1px;
    padding-inline: 6px;
    font-size: var(--font-size-sm);
  }

  wa-select::part(expand-icon) {
    margin-inline-start: var(--wa-space-3xs);
  }

  wa-select::part(listbox) {
    padding-block: var(--wa-space-3xs);
    border-radius: var(--border-radius);
    box-shadow: var(--wa-shadow-s, var(--wa-shadow-m));
  }

  wa-select wa-option::part(base) {
    min-height: 22px;
    padding: 2px 8px 2px 4px;
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  wa-input {
    font-size: var(--font-size-sm);
  }

  wa-input::part(base) {
    min-height: 22px;
    padding-block: 0;
    border: var(--border-thin) solid
      var(--wa-color-surface-border, var(--color-border));
  }

  wa-input::part(input) {
    padding-block: 1px;
    padding-inline: 6px;
    font-size: var(--font-size-sm);
  }
`;

export const selectStyles: CSSResult = css`
  .select-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
  }

  .select-group wa-icon {
    margin-right: var(--wa-space-2xs);
    color: var(--text-color, var(--wa-color-text-normal));
    vertical-align: text-bottom;
  }

  .select-group wa-select {
    flex: 1;
    min-width: 6rem;
    max-width: 10rem;
  }

  .agent-select-controls {
    flex: 0 1 auto;
    min-width: 7rem;
    max-width: 10rem;
  }

  .agent-select-dropdowns {
    position: relative;
    width: 100%;
    min-width: 7rem;
    max-width: 10rem;
  }

  wa-option {
    font-family: var(--wa-font-family-body);
  }

  wa-option[disabled],
  wa-option[data-requires-key='true'] {
    color: var(--color-text-secondary, var(--wa-color-text-quiet));
    opacity: var(--opacity-subtle, 0.7);
    font-style: italic;
  }

  wa-option[data-tool-use='true'] {
    font-style: italic;
  }

  .clickable {
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .clickable:hover {
    color: var(--wa-color-text-normal);
  }

  .clickable:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  wa-icon.clickable:hover {
    color: var(--button-hover-background, var(--wa-color-button-hover));
  }

  wa-select::part(listbox) {
    max-height: var(--height-large, 300px);
  }

  /* Compact form controls — stricter IDE-density inputs/selects.
   * Border uses subtle surface-border, not heavier panel border. */
  ${compactFormControlStyles}

  .model-option-status {
    color: var(--wa-color-danger-on-quiet);
    opacity: var(--opacity-full);
    font-style: normal;
    margin-left: var(--wa-space-3xs);
  }
`;
