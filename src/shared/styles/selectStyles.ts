import { css, type CSSResult } from 'lit';

/**
 * Compact wa-input / wa-select sizing — stricter IDE-density form controls.
 * WA defaults to ~38px tall; the host's `--height-control-compact` pulls that
 * down to editor-panel density in the extension and window density on desktop.
 *
 * Exported as a focused subset so file-select / main-view components can pull
 * just the input/select rules without inheriting the full select sheet. The
 * canonical skin (`formControlStyles` in controlStyles.ts) interpolates this
 * and adds `wa-textarea`, the option row, and `.input-plain`; import that
 * unless you specifically want only these two elements.
 */
export const compactFormControlStyles: CSSResult = css`
  wa-select {
    font-size: var(--font-size-sm);
  }

  wa-select::part(combobox) {
    min-height: var(--height-control-compact);
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

  wa-input {
    font-size: var(--font-size-sm);
  }

  wa-input::part(base) {
    min-height: var(--height-control-compact);
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

  .select-group wa-select {
    flex: 1;
    min-width: 6rem;
    max-width: 10rem;
  }

  wa-option {
    font-family: var(--wa-font-family-body);
  }

  wa-option[disabled],
  wa-option[data-requires-key='true'] {
    color: var(--color-text-muted);
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

  wa-icon.clickable:hover {
    color: var(--button-hover-background, var(--wa-color-button-hover));
  }

  wa-select::part(listbox) {
    max-height: var(--height-large, 300px);
  }

  .model-option-status {
    color: var(--wa-color-danger-on-quiet);
    opacity: var(--opacity-full);
    font-style: normal;
    margin-inline-start: var(--wa-space-3xs);
  }

  /* Quiet trailing marker on picker options (e.g. the team picker's "Custom"
     provenance tag) — text, not color alone, carries the distinction. */
  .option-suffix {
    color: var(--wa-color-text-quiet);
    font-style: normal;
    margin-inline-start: var(--wa-space-3xs);
  }
`;
