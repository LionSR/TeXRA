import { css, type CSSResult } from 'lit';

import { compactFormControlStyles } from './selectStyles';

/**
 * Compact icon-only action button — stricter minimalism.
 * 20×20, no hover fill, opacity-driven hover/disabled.
 *
 * Exported as a focused subset so file-select/main-view components can pull
 * just the icon-button rules without inheriting the full common view sheet.
 * `commonViewStyles` below interpolates this block to keep a single source
 * of truth for the selectors.
 */
export const compactIconActionButtonStyles: CSSResult = css`
  .action-icon-button {
    flex-shrink: 0;
  }

  .action-icon-button::part(base) {
    width: 20px;
    min-width: 0;
    height: 20px;
    min-height: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(
      --wa-color-text-quiet,
      var(--wa-color-text-quiet, var(--wa-color-text-normal))
    );
    opacity: var(--opacity-subtle);
    transition: opacity var(--transition-fast);
  }

  .action-icon-button::part(base):hover {
    opacity: var(--opacity-full);
    background: transparent;
  }

  .action-icon-button:focus-visible::part(base) {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
  }

  .action-icon-button[disabled]::part(base) {
    opacity: 0.35;
    background: transparent;
  }

  .action-icon-button wa-icon {
    font-size: 13px;
  }
`;

export const commonViewStyles: CSSResult = css`
  .view-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--wa-space-l);
  }

  .view-header h1,
  .view-header h2 {
    margin: 0;
  }

  .view-header h1 {
    color: var(--color-text-link);
  }

  .list-item {
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius-large);
    padding: var(--wa-space-xs);
    background-color: var(--wa-color-surface-default);
  }

  .list-item:hover {
    background-color: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 30%,
      transparent
    );
  }

  .list-item:focus-within {
    outline: var(--border-thin) solid var(--wa-color-focus);
  }

  .list-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .collapsible {
    margin-top: var(--wa-space-2xs);
  }

  /*
   * Legacy vscode-collapsible support: 'body' is the part name for that
   * component. Long content historically clipped at --height-max; the grid
   * trick below replaces the discrete max-height jump for wa-details
   * ('content' part), which is the modern variant.
   */
  .collapsible::part(body) {
    max-height: var(--height-medium);
    overflow: hidden;
  }

  .collapsible[open]::part(body) {
    max-height: var(--height-max);
  }

  .collapsible::part(content) {
    display: grid;
    grid-template-rows: 1fr;
  }

  .collapsible:not([open])::part(content) {
    grid-template-rows: 0fr;
  }

  .collapsible::part(content) > * {
    overflow: hidden;
    min-height: 0;
  }

  /* Panel collapsible - consistent styling for collapsible panels */
  .panel-collapsible {
    border-top: var(--border-thin) solid var(--color-border);
  }

  .panel-collapsible::part(header) {
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    background-color: var(--wa-color-surface-lowered, transparent);
    color: var(--wa-color-text-normal);
  }

  /* "body" part is used by vscode-collapsible; "content" part by wa-details. */
  .panel-collapsible::part(body),
  .panel-collapsible::part(content) {
    padding: 0 var(--wa-space-2xs) var(--wa-space-2xs);
  }

  /* wa-details exposes the body via the 'content' part. The grid 1fr/0fr
     trick lets long content scale without a fixed max-height cap. The
     direct child wrapper carries 'overflow: hidden' and 'min-height: 0'
     so the grid row can clamp it without truncation jumps. */
  .panel-collapsible::part(content) {
    display: grid;
    grid-template-rows: 1fr;
  }

  .panel-collapsible:not([open])::part(content) {
    grid-template-rows: 0fr;
  }

  .panel-collapsible::part(content) > * {
    overflow: hidden;
    min-height: 0;
  }

  vscode-toolbar-container {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex-wrap: nowrap;
  }

  vscode-toolbar-button {
    flex-shrink: 0;
  }

  .action-button-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex-wrap: nowrap;
  }

  /* Compact action button (with text) — stricter IDE-density chrome.
   * Borderless default; hover adds a subtle border (no fill swap). */
  .action-button::part(base) {
    gap: var(--wa-space-2xs);
    min-height: 22px;
    padding: 0 6px;
    border: var(--border-thin) solid transparent;
    background: transparent;
    font-size: var(--font-size-sm);
  }

  .action-button::part(base):hover {
    background: transparent;
    border-color: var(--wa-color-surface-border, var(--color-border));
  }

  .action-button wa-icon {
    font-size: var(--font-size-sm);
  }

  ${compactIconActionButtonStyles}
  ${compactFormControlStyles}

  /* Stricter compactness for wa-checkbox / wa-radio — smaller label,
   * tighter gap between control and label. */
  wa-checkbox,
  wa-radio {
    font-size: var(--font-size-sm);
  }

  wa-checkbox::part(label),
  wa-radio::part(label) {
    font-size: var(--font-size-sm);
    padding-inline-start: var(--wa-space-2xs);
  }

  wa-checkbox::part(base),
  wa-radio::part(base) {
    gap: var(--wa-space-2xs);
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
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .detail-section {
    margin: var(--wa-space-2xs) 0;
  }

  .detail-content {
    padding: var(--wa-space-3xs) 0 var(--wa-space-2xs) var(--wa-space-s);
  }

  .detail-list {
    list-style: none;
    margin: 0;
  }

  .detail-item {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .details-summary {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-3xs) 0;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .details-summary:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
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
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--wa-space-xs);
    margin-top: calc(var(--wa-space-l) * 2);
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .empty-state wa-icon {
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
  }

  .btn-secondary:hover {
    opacity: var(--opacity-full);
  }

  .btn-secondary:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
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
    gap: var(--wa-space-2xs);
    min-height: 22px;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    font-family: inherit;
    color: var(--wa-color-text-normal);
    background: none;
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    cursor: pointer;
    transition:
      color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .tab-action-btn:hover {
    color: var(--wa-color-text-normal);
    border-color: var(--wa-color-focus);
  }

  .tab-action-btn:active {
    background: var(--wa-color-toolbar-active, rgba(99, 102, 103, 0.31));
  }

  .tab-action-btn:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
  }

  /* Shared settings reminder for compact informational panels at the top of tabs */
  .settings-reminder {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: var(--wa-space-xs);
    row-gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    margin-bottom: var(--wa-space-s);
    border: var(--border-thin) solid var(--wa-color-focus);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-default);
  }

  .settings-reminder-icon {
    grid-row: 1 / -1;
    margin-top: 2px;
    font-size: var(--font-size-lg);
    color: var(--wa-color-focus);
  }

  .settings-reminder-title {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
  }

  .settings-reminder-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .settings-reminder-body {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
    min-width: 0;
  }

  .settings-reminder-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .settings-reminder-list {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .settings-reminder-list li {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
  }

  .settings-reminder-step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border-radius: 50%;
    color: var(--wa-color-surface-default);
    background: var(--wa-color-focus);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-tight);
  }

  /* Shared section header — uppercase divider used across settings tabs.
     LaTeXTab uses .section-header; ToolsTab uses .category-header. Both
     resolve to identical chrome here. */
  .section-header,
  .category-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding-bottom: var(--wa-space-2xs);
    margin-bottom: var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Utility: single-line text truncation with ellipsis */
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .focus-ring--inset:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
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
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    font-size: var(--font-size);
    font-family: inherit;
    color: var(--wa-color-brand-on-loud);
    background: var(--wa-color-brand-fill-loud);
    border: var(--border-thin) solid var(--wa-color-button-border, transparent);
    border-radius: var(--border-radius);
    cursor: pointer;
    transition:
      background-color var(--transition-fast),
      opacity var(--transition-fast);
  }

  .filled-button:hover {
    background: var(--wa-color-button-hover);
  }

  .filled-button:active {
    opacity: var(--opacity-normal);
  }

  .filled-button:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
  }

  .filled-button--secondary {
    color: var(--wa-color-neutral-on-quiet, inherit);
    background: var(--wa-color-neutral-fill-quiet, transparent);
  }

  /* Specificity-only override: pins hover to the same value as the base
     state so the base .filled-button:hover doesn't flash secondary buttons
     to the brand color. Intentionally produces no visual hover feedback —
     secondary actions are quiet by design. */
  .filled-button--secondary:hover {
    background: var(--wa-color-neutral-fill-quiet, transparent);
  }
`;
