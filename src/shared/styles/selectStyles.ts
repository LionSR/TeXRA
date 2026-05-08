import { css, type CSSResult } from 'lit';

export const selectStyles: CSSResult = css`
  .select-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-tiny);
  }

  .select-group .codicon {
    margin-right: var(--spacing-small);
    color: var(--text-color, var(--texra-foreground));
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
    color: var(--color-text-secondary, var(--texra-descriptionForeground));
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
    color: var(--texra-foreground);
  }

  .clickable:focus-visible {
    outline: var(--border-thin) solid var(--texra-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .codicon.clickable:hover {
    color: var(--button-hover-background, var(--texra-button-hoverBackground));
  }

  wa-select::part(listbox) {
    max-height: var(--height-large, 300px);
  }

  .api-key-missing {
    color: var(--texra-errorForeground);
    opacity: var(--opacity-full);
    font-style: normal;
    margin-left: var(--spacing-tiny);
  }
`;
