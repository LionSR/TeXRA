// Third-party imports
import { css, type CSSResult } from 'lit';

/**
 * Common view styles shared across Lit webviews.
 * Mirrors core rules from common.css for shadow DOM usage.
 */
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

  .text-secondary {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .empty-state {
    text-align: center;
    margin-top: calc(var(--spacing-xlarge) * 2);
    color: var(--color-text-secondary);
  }

  /* Note: Badge base styles are in @shared/styles/badgeStyles.ts
     Use badgeStyles for components that need badge functionality */
`;
