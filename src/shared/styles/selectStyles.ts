import { css, type CSSResult } from 'lit';

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
    font-family: var(--texra-font-family);
  }

  wa-option.disabled-option,
  wa-option.disabled-model,
  wa-option.disabled-agent,
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
    color: var(--button-hover-background, var(--texra-button-hoverBackground));
  }

  wa-select::part(listbox) {
    max-height: var(--height-large, 300px);
  }

  /* Compact form controls — stricter IDE-density inputs/selects.
   * WA defaults to ~38px tall; reduce to ~22px for minimal VS Code chrome.
   * Border uses subtle surface-border, not heavier panel border. */
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

  .api-key-missing {
    color: var(--texra-errorForeground);
    opacity: var(--opacity-full);
    font-style: normal;
    margin-left: var(--wa-space-3xs);
  }
`;
