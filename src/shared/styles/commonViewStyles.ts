import { css, type CSSResult } from 'lit';

export const commonViewStyles: CSSResult = css`
  .view-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-xlarge);
  }

  .view-header h1,
  .view-header h2 {
    margin: 0;
  }

  .view-header h1 {
    color: var(--color-text-link);
  }

  .list-item {
    border: var(--border-thin) solid var(--vscode-panelSection-border);
    border-radius: var(--border-radius-large);
    padding: var(--spacing-medium);
    background-color: var(--vscode-editor-background);
  }

  .list-item:hover {
    background-color: var(--vscode-list-hoverBackground);
  }

  .list-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .collapsible {
    margin-top: var(--spacing-small);
  }

  .collapsible::part(body) {
    max-height: var(--height-medium);
    overflow: hidden;
    transition: max-height 0.3s ease;
  }

  .collapsible[open]::part(body) {
    max-height: var(--height-max);
  }

  vscode-toolbar-container {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex-wrap: nowrap;
  }

  vscode-toolbar-button {
    flex-shrink: 0;
  }

  .clickable-link {
    cursor: pointer;
    color: var(--color-text-link);
    text-decoration: none;
  }

  .clickable-link:hover {
    color: var(--color-text-link-active);
    text-decoration: underline;
  }

  .detail-section {
    margin: var(--spacing-small) 0;
  }

  .detail-content {
    padding: var(--spacing-tiny) 0 var(--spacing-small) var(--spacing-large);
  }

  .detail-list {
    list-style: none;
    margin: 0;
  }

  .detail-item {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .details-summary {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    padding: var(--spacing-tiny) 0;
    cursor: pointer;
    list-style: none;
    user-select: none;
    opacity: var(--opacity-normal);
  }

  .details-summary:hover {
    opacity: 1;
  }

  .details-summary::-webkit-details-marker {
    display: none;
  }

  /* Toggle icon for collapsible details - applies to any summary */
  summary .toggle-icon {
    opacity: var(--opacity-subtle);
    font-size: var(--font-size-sm);
    display: inline-block;
  }

  details[open] > summary .toggle-icon {
    transform: rotate(90deg);
  }

  .text-secondary {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .empty-state {
    text-align: center;
    margin-top: calc(var(--spacing-xlarge) * 2);
    color: var(--color-text-secondary);
    font-style: italic;
  }

  /* Agent icon indicators (remote, multiple outputs) - fixed width for consistent sizing */
  .agent-icon {
    display: inline-block;
    width: 1.2em;
    text-align: center;
  }

  [hidden] {
    display: none !important;
  }

  .btn-secondary {
    opacity: var(--opacity-normal);
  }

  .btn-secondary:hover {
    opacity: var(--opacity-full);
  }
`;
