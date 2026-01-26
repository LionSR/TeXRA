/**
 * Shared collapsible section styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - vscode-collapsible component parts
 * - Header and body styling
 * - Expandable/collapsible animations
 *
 * Used by: TodoList, FileList, FollowupSection, QueuedFollowUps
 *
 * @example
 * import { collapsibleStyles } from '@shared/styles/collapsibleStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, collapsibleStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const collapsibleStyles: CSSResult = css`
  /* Base collapsible - reset margin */
  .collapsible,
  .files-collapsible,
  .todo-collapsible,
  .followup-collapsible,
  .queued-follow-ups-collapsible {
    margin: 0;
  }

  /* Header styling - consistent across all collapsible types */
  .collapsible::part(header),
  .files-collapsible::part(header),
  .todo-collapsible::part(header),
  .followup-collapsible::part(header),
  .queued-follow-ups-collapsible::part(header) {
    padding: var(--spacing-tiny, 2px) var(--spacing-medium, 8px);
    background-color: var(
      --vscode-sideBarSectionHeader-background,
      transparent
    );
    color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
  }

  /* Body styling - consistent padding */
  .collapsible::part(body),
  .files-collapsible::part(body),
  .todo-collapsible::part(body),
  .followup-collapsible::part(body),
  .queued-follow-ups-collapsible::part(body) {
    padding: 0 var(--spacing-small, 4px) var(--spacing-tiny, 2px);
  }

  /* Max height and overflow for body content */
  .collapsible::part(body) {
    max-height: var(--height-medium, 200px);
    overflow: hidden;
    transition: max-height 0.3s ease;
  }

  .collapsible[open]::part(body) {
    max-height: var(--height-max, 1000px);
  }

  /* Title styling within collapsible header */
  .collapsible-title {
    font-weight: 500;
    font-size: var(--font-size-sm, 12px);
  }

  /* Count badge in header */
  .collapsible-count {
    margin-left: var(--spacing-small, 4px);
    font-size: var(--font-size-sm, 12px);
    color: var(--color-text-secondary, var(--vscode-descriptionForeground));
  }

  /* Actions container in header */
  .collapsible-actions {
    display: flex;
    gap: var(--spacing-tiny, 2px);
    margin-left: auto;
  }

  /* Inner content wrapper */
  .collapsible-content {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small, 4px);
  }
`;
