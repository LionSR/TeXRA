import { css, type CSSResult } from 'lit';

import { compactFormControlStyles } from './selectStyles';

/**
 * Header action button — `<wa-button class="header-action">` in view headers.
 * Prevents the button from shrinking and pins its minimum hit area to the
 * shared `--height-control` token. Both the main webview and the progress view
 * root components share this pattern.
 */
export const headerActionStyles: CSSResult = css`
  .header-action {
    flex-shrink: 0;
  }

  .header-action::part(base) {
    min-height: var(--height-control, 24px);
  }
`;

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
    color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
    opacity: var(--opacity-subtle);
    transition: opacity var(--transition-fast);
  }

  .action-icon-button::part(base):hover {
    opacity: var(--opacity-full);
    background: transparent;
  }

  .action-icon-button:focus-visible::part(base) {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: var(--border-thin);
  }

  .action-icon-button[disabled]::part(base) {
    opacity: var(--opacity-faint);
    background: transparent;
  }

  .action-icon-button wa-icon {
    font-size: 13px;
  }
`;

/**
 * Busy state for an icon action button: a spinner overlays the button while
 * it works, instead of taking its own slot. The button stays in the flow
 * (so the toolbar never shifts when the busy flag toggles) and its glyph is
 * hidden under the spinner. Emitted by `renderIconActionButton({ busy })` —
 * the helper owns the markup, this sheet styles the class hooks.
 *
 * Interpolated into `commonViewStyles` below so the selectors have a single
 * source of truth.
 */
const busyIconButtonStyles: CSSResult = css`
  .action-icon-busy {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .action-icon-busy wa-button.is-busy {
    visibility: hidden;
  }

  .action-icon-busy .action-busy-spinner {
    position: absolute;
    inset: 0;
    margin: auto;
    font-size: var(--font-size-icon, 1em);
    pointer-events: none;
  }
`;

/**
 * Single-line text truncation declarations (no selector). Interpolate this
 * into a rule when the truncated target is a shadow part (e.g.
 * `::part(label)`) that can't take the `.truncate` class directly.
 */
export const truncateTextRule: CSSResult = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

  /* Panel collapsible - consistent styling for collapsible panels */
  .panel-collapsible {
    border-top: var(--border-thin) solid var(--color-border);
  }

  /* The host rules above and below own panel boundaries, while the header
     supplies the lowered surface. Remove Web Awesome's default card chrome
     so stacked panels and nested round disclosures remain flat. */
  .panel-collapsible::part(base) {
    background: transparent;
    border: none;
    border-radius: 0;
  }

  /* Boxed variant: also rule off the bottom edge so the panel reads as a
     standalone band (used by the Plan and Todos panels in the progress board). */
  .panel-collapsible.is-boxed {
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .panel-collapsible::part(header) {
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    background-color: var(--wa-color-surface-lowered, transparent);
    color: var(--wa-color-text-normal);
  }

  /* wa-details exposes the body via the 'content' part. The grid 1fr/0fr
     trick lets long content scale without a fixed max-height cap. The
     direct child wrapper carries 'overflow: hidden' and 'min-height: 0'
     so the grid row can clamp it without truncation jumps. */
  .panel-collapsible::part(content) {
    padding: 0 var(--wa-space-2xs) var(--wa-space-2xs);
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

  /* Quiet collapsible - a borderless, low-emphasis disclosure for inline
     toggles (e.g. "Show full instructions" or a memory "Contents" preview).
     One shared look so the same control reads identically wherever it appears,
     instead of each call site rolling its own header padding/size/color. */
  .collapsible-quiet::part(base) {
    background: transparent;
    border: none;
    border-radius: 0;
  }

  .collapsible-quiet::part(header) {
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    min-height: 20px;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight);
    color: var(--wa-color-text-quiet);
  }

  .collapsible-quiet[open]::part(header) {
    color: var(--wa-color-text-normal);
  }

  /* Same grid 1fr/0fr collapse as .panel-collapsible so the quiet variant is
     self-contained. */
  .collapsible-quiet::part(content) {
    display: grid;
    grid-template-rows: 1fr;
    padding: var(--wa-space-2xs) 0 0;
  }

  .collapsible-quiet:not([open])::part(content) {
    grid-template-rows: 0fr;
  }

  .collapsible-quiet::part(content) > * {
    overflow: hidden;
    min-height: 0;
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
    min-height: var(--height-control-compact);
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

  ${headerActionStyles}
  ${compactIconActionButtonStyles}
  ${busyIconButtonStyles}
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
    outline-offset: var(--border-thin);
    border-radius: var(--border-radius-small);
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
    outline-offset: var(--border-thin);
    border-radius: var(--border-radius-small);
  }

  /* Compact banner variant used by progress-view custom-element panels. */
  wa-details.banner-details::part(base) {
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  wa-details.banner-details::part(header),
  wa-details.banner-details::part(content) {
    padding: 0;
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

  /* Structure owned by the shared renderLoadingState helper (@shared/wa) */
  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-l);
    color: var(--color-text-secondary);
  }

  .empty-state wa-icon {
    font-size: calc(var(--font-size) * 2.5);
    opacity: var(--opacity-disabled);
  }

  /* Class hooks consumed by the shared renderEmptyState() helper
     (@shared/wa/emptyState). Neutralizes the UA heading chrome on
     .empty-state-title (bold weight, larger size, block margins) so it
     reads like the plain paragraph text these lists used before adopting
     the helper; color/italic still cascade from .empty-state. */
  .empty-state .empty-state-title {
    margin: 0;
    font-size: var(--font-size);
    font-weight: var(--wa-font-weight-regular, normal);
  }

  .empty-state .empty-state-body {
    margin: 0;
    /* Body copy was <p class="text-secondary"> before the helper: keep the
       smaller secondary sizing so it stays subordinate to the title (color
       already cascades from .empty-state). */
    font-size: var(--font-size-sm);
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

  /* Shared tab content container — consistent max-width and centering for all settings tabs */
  .tab-content-container {
    max-width: 1000px;
    margin: 0 auto;
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
    letter-spacing: var(--letter-spacing-caps);
  }

  /* Utility: single-line text truncation with ellipsis */
  .truncate {
    ${truncateTextRule}
  }
`;
