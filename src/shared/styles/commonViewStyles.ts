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

  .list-item:focus-within {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }

  .list-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing-small);
  }

  .collapsible {
    margin-top: var(--spacing-small);
  }

  .collapsible::part(body) {
    max-height: var(--height-medium);
    overflow: hidden;
    transition: max-height var(--transition-slow);
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
  }

  .clickable-link {
    cursor: pointer;
    color: var(--color-text-link);
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .clickable-link:hover {
    color: var(--color-text-link-active);
    text-decoration: underline;
  }

  .clickable-link:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
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
    transition: opacity var(--transition-fast);
  }

  .details-summary:hover {
    opacity: var(--opacity-full);
  }

  .details-summary:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  /* Toggle icon for collapsible details - applies to any summary */
  summary .toggle-icon {
    opacity: var(--opacity-subtle);
    font-size: var(--font-size-sm);
    display: inline-block;
    transition: transform var(--transition-fast);
  }

  details[open] > summary .toggle-icon {
    transform: rotate(90deg);
  }

  .text-secondary {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-medium);
    margin-top: calc(var(--spacing-xlarge) * 2);
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .empty-state .codicon {
    font-size: calc(var(--font-size) * 2.5);
    opacity: var(--opacity-disabled);
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
    transition: opacity var(--transition-fast);
  }

  .btn-secondary:hover {
    opacity: var(--opacity-full);
  }

  .btn-secondary:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  /* Shared tab content container — consistent max-width and centering for all settings tabs */
  .tab-content-container {
    max-width: 1000px;
    margin: 0 auto;
  }

  /* Shared small action button — outlined style used in tab toolbars */
  .tab-action-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
    padding: var(--spacing-tiny) var(--spacing-small);
    font-size: var(--font-size-xs);
    font-family: inherit;
    color: var(--color-text-secondary);
    background: none;
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    cursor: pointer;
    transition:
      color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .tab-action-btn:hover {
    color: var(--vscode-foreground);
    border-color: var(--vscode-focusBorder);
  }

  .tab-action-btn:active {
    background: var(
      --vscode-toolbar-activeBackground,
      rgba(99, 102, 103, 0.31)
    );
  }

  .tab-action-btn:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  /* Utility: single-line text truncation with ellipsis */
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Utility: minimal icon button reset (no background, no border) */
  .icon-btn-reset {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    color: inherit;
    opacity: var(--opacity-subtle);
    transition: opacity var(--transition-fast);
  }

  .icon-btn-reset:hover {
    opacity: var(--opacity-full);
  }

  .icon-btn-reset:active {
    transform: scale(0.95);
  }

  .icon-btn-reset:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }
`;

/**
 * Reusable focus-visible ring styles.
 *
 * Apply via Lit's static styles array:
 *   static override styles = [designTokens, focusRingStyles, css`...`];
 *
 * Then add the `.focus-ring` class to any interactive element that needs
 * a standard keyboard-focus outline:
 *   <button class="focus-ring" ...>
 *
 * Variants:
 *   `.focus-ring--inset`  — outline-offset: -1px (inner focus ring)
 */
export const focusRingStyles: CSSResult = css`
  .focus-ring:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .focus-ring--inset:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: -1px;
    border-radius: var(--border-radius-small);
  }
`;

/**
 * Shared filled primary button styles.
 *
 * Canonical look mirroring `vscode-button` for use cases that need a
 * regular `<button>` (e.g. inside templated lists or modals). Prefer this
 * over reinventing padding/background/focus per component.
 *
 * Apply via Lit's static styles array:
 *   static override styles = [designTokens, filledButtonStyles, css`...`];
 *
 * Then add the `.filled-button` class to any `<button>`. Add
 * `.filled-button--secondary` for the secondary tone.
 */
export const filledButtonStyles: CSSResult = css`
  .filled-button {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
    padding: var(--spacing-small) var(--spacing-medium);
    font-size: var(--font-size);
    font-family: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: var(--border-thin) solid var(--vscode-button-border, transparent);
    border-radius: var(--border-radius);
    cursor: pointer;
    transition:
      background-color var(--transition-fast),
      opacity var(--transition-fast);
  }

  .filled-button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .filled-button:active {
    opacity: var(--opacity-normal);
  }

  .filled-button:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .filled-button--secondary {
    color: var(--vscode-button-secondaryForeground, inherit);
    background: var(--vscode-button-secondaryBackground, transparent);
  }

  .filled-button--secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, transparent);
  }
`;
