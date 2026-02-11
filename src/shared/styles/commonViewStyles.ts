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

  /* Panel collapsible - consistent styling for collapsible panels */
  .panel-collapsible {
    border-top: var(--border-thin) solid var(--color-border);
  }

  .panel-collapsible::part(header) {
    padding: var(--spacing-small) var(--spacing-medium);
    background-color: var(
      --vscode-sideBarSectionHeader-background,
      transparent
    );
    color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
  }

  .panel-collapsible::part(body) {
    padding: 0 var(--spacing-small) var(--spacing-small);
  }

  vscode-toolbar-container {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex-wrap: nowrap;
  }

  vscode-toolbar-button {
    flex-shrink: 0;
    position: relative;
  }

  /* Tooltip on hover for icon-only toolbar buttons */
  vscode-toolbar-button[title]:not(:empty)::after {
    display: none;
  }

  vscode-toolbar-button[title]::after {
    content: attr(title);
    position: absolute;
    left: 50%;
    top: 100%;
    transform: translateX(-50%);
    margin-top: var(--spacing-tiny);
    padding: var(--spacing-small) var(--spacing-medium);
    background: var(--background-color);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius-small);
    font-size: var(--font-size-sm);
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
    z-index: 100;
  }

  vscode-toolbar-button[title]:hover::after {
    opacity: var(--opacity-full);
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
