import { css, type CSSResult } from 'lit';

export const selectStyles: CSSResult = css`
  .select-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-tiny);
  }

  .select-group .codicon {
    margin-right: var(--spacing-small);
    color: var(--text-color, var(--vscode-foreground));
    vertical-align: text-bottom;
  }

  .select-group vscode-single-select {
    flex: 1;
    min-width: 6rem;
    max-width: 10rem;
  }

  .agent-select-controls {
    flex: 1;
    min-width: 10rem;
    max-width: 14rem;
  }

  .agent-select-dropdowns {
    position: relative;
    width: 100%;
    min-width: 10rem;
    max-width: 14rem;
  }

  vscode-option {
    font-family: var(--vscode-font-family);
  }

  vscode-option.disabled-option,
  vscode-option.disabled-model,
  vscode-option.disabled-agent,
  vscode-option[data-requires-key='true'] {
    color: var(--color-text-secondary, var(--vscode-descriptionForeground));
    opacity: var(--opacity-subtle, 0.7);
    font-style: italic;
  }

  vscode-option[data-tool-use='true'] {
    font-style: italic;
  }

  .clickable {
    cursor: pointer;
  }

  .clickable:hover {
    color: var(--vscode-foreground);
  }

  .codicon.clickable:hover {
    color: var(--button-hover-background, var(--vscode-button-hoverBackground));
  }

  vscode-single-select::part(listbox) {
    max-height: var(--height-large, 300px);
  }

  .api-key-missing {
    color: var(--vscode-errorForeground);
    opacity: 1;
    font-style: normal;
    margin-left: var(--spacing-tiny);
  }
`;
