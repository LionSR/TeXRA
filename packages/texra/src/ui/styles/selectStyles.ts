import { css, type CSSResult } from 'lit';

/**
 * Compact wa-input / wa-select sizing — stricter IDE-density form controls.
 * WA defaults to ~38px tall; the host's `--height-control` pulls that
 * down to editor-panel density in the extension and window density on desktop.
 *
 * Exported as a focused subset so file-select / main-view components can pull
 * just the input/select rules without inheriting the full select sheet. The
 * canonical skin (`formControlStyles` in controlStyles.ts) interpolates this
 * and adds `wa-textarea`, the option row, and `.input-plain`; import that
 * unless you specifically want only these two elements.
 */
export const compactFormControlStyles: CSSResult = css`
  wa-input,
  wa-select,
  wa-textarea {
    min-width: 0;
    font-family: var(--font-family);
    font-size: var(--font-size);
    --wa-form-control-height: var(--height-control);
  }

  :is(wa-input, wa-select, wa-textarea)::part(label) {
    margin-block-end: var(--wa-space-2xs);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-normal);
  }

  :is(wa-input, wa-select, wa-textarea)::part(hint) {
    margin-block-start: var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    line-height: var(--line-height-normal);
  }

  wa-select::part(combobox) {
    min-height: var(--height-control);
    min-width: 0;
    padding-block: 0;
    padding-inline: var(--control-padding-inline);
    border: var(--border-thin) solid var(--wa-form-control-border-color);
  }

  wa-select::part(display-input) {
    padding: 0;
    font-size: var(--font-size);
  }

  wa-select::part(expand-icon) {
    margin-inline-start: var(--wa-space-3xs);
  }

  wa-select::part(listbox) {
    padding-block: var(--wa-space-3xs);
    border-radius: var(--border-radius);
    box-shadow: var(--wa-shadow-s, var(--wa-shadow-m));
  }

  wa-input::part(base) {
    box-sizing: border-box;
    height: var(--height-control);
    min-height: var(--height-control);
    padding: 0;
    border: var(--border-thin) solid var(--wa-form-control-border-color);
  }

  wa-input::part(input) {
    padding-block: 0;
    padding-inline: var(--control-padding-inline);
    font-size: var(--font-size);
    height: 100%;
    min-width: 0;
  }

  wa-input::part(start) {
    padding-inline-start: var(--control-padding-inline);
  }

  wa-input::part(end) {
    padding-inline-end: var(--control-padding-inline);
  }

  /* Web Awesome draws focus as an outline offset outside the border, which
     reads as a second ring floating around every field. A field shows focus
     once: its border takes the focus color and the halo hugs it. */
  wa-input::part(base),
  wa-select::part(combobox),
  wa-textarea::part(base) {
    border-radius: var(--field-radius);
    outline: none;
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast);
  }

  wa-input:focus-within::part(base),
  wa-select:focus-within::part(combobox),
  wa-textarea:focus-within::part(base) {
    border-color: var(--wa-color-focus);
    box-shadow: var(--field-focus-halo);
  }

  wa-input:focus-visible,
  wa-select:focus-visible,
  wa-textarea:focus-visible {
    outline: none;
  }

  /* The plain skin (controlStyles.ts) owns a whole band; the band is the
     affordance, so its focus keeps the hairline and draws no halo. */
  .input-plain:focus-within::part(base) {
    border-bottom-color: var(--border-hairline);
    box-shadow: none;
  }
`;

export const selectStyles: CSSResult = css`
  wa-option {
    font-family: var(--wa-font-family-body);
  }

  wa-option[disabled],
  wa-option[data-requires-key='true'] {
    color: var(--color-text-muted);
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
`;
