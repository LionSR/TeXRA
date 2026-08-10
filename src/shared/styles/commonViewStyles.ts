import { css, type CSSResult } from 'lit';

import {
  buttonStyles,
  focusRingStyles,
  formControlStyles,
  iconSurfaceStyles,
  settingsRowStyles,
} from './controlStyles';

/**
 * Available to the accessibility tree, absent from the layout. The canonical
 * copy across every view surface (InstructionPanel and WorktreeChip both
 * used to carry their own). Exported on its own — interpolated into
 * `commonViewStyles` below — for roots that compose a narrower sheet and so
 * cannot take the full common one (ProgressApp's `.view-header` rules would
 * clash with this sheet's).
 */
export const visuallyHiddenStyles: CSSResult = css`
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
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

  .settings-disclosure-list {
    display: grid;
    gap: var(--wa-space-2xs);
  }

  .settings-disclosure {
    overflow: hidden;
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-default);
  }

  .settings-disclosure-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    min-height: var(--control-size-l);
    color: var(--wa-color-text-normal);
    transition: background-color var(--transition-fast);
  }

  .settings-disclosure-summary:hover {
    background: var(--surface-hover);
  }

  .settings-disclosure-toggle {
    display: block;
    min-width: 0;
  }

  .settings-disclosure-toggle::part(base) {
    justify-content: flex-start;
    width: 100%;
    min-height: var(--control-size-l);
    padding: var(--wa-space-xs);
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
  }

  .settings-disclosure-toggle::part(label) {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    width: 100%;
    min-width: 0;
  }

  .settings-disclosure-toggle:hover::part(base) {
    background: transparent;
  }

  .settings-disclosure-chevron {
    display: grid;
    width: 1em;
    height: 1em;
    flex: 0 0 1em;
    place-items: center;
    color: var(--color-text-secondary);
    transition: transform var(--transition-fast);
  }

  .settings-disclosure-toggle[aria-expanded='true']
    .settings-disclosure-chevron {
    transform: rotate(90deg);
  }

  .settings-disclosure-status,
  .settings-disclosure-actions {
    padding-inline-end: var(--wa-space-xs);
    white-space: nowrap;
  }

  .settings-disclosure-actions {
    display: flex;
    align-items: center;
  }

  .settings-disclosure-content {
    padding: var(--wa-space-xs);
    border-top: var(--border-thin) solid var(--color-border);
    background: var(--wa-color-surface-lowered);
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

  ${buttonStyles}
  ${iconSurfaceStyles}
  ${busyIconButtonStyles}
  ${formControlStyles}
  ${focusRingStyles}

  ${visuallyHiddenStyles}
  ${settingsRowStyles}

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
    /* No fill or border to round — this is here so the shared focus ring,
       which follows the element's own radius, doesn't draw a hard rectangle
       around a text link. */
    border-radius: var(--border-radius);
    color: var(--color-text-link);
    /* Inline-in-prose link: underline at rest, since hue alone is not a
       reliable 3:1 cue against surrounding text across host themes. */
    text-decoration: underline;
    transition: color var(--transition-fast);
  }

  .clickable-link:hover {
    color: var(--color-text-link-active);
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
    border-radius: var(--border-radius);
    cursor: pointer;
    list-style: none;
    user-select: none;
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
    color: var(--color-text-muted);
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
    box-sizing: border-box;
    width: 100%;
    max-width: 1000px;
    margin: 0 auto;
  }

  .settings-section-heading {
    display: grid;
    gap: var(--wa-space-3xs);
    margin: var(--wa-space-l) 0 var(--wa-space-xs);
    padding-bottom: var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .settings-section-heading-row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    min-width: 0;
  }

  .settings-section-heading-icon {
    display: grid;
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    place-items: center;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size);
  }

  .settings-section-heading-title {
    margin: 0;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-tight);
  }

  .settings-section-heading-description {
    max-width: 72ch;
    margin: 0;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
  }

  .settings-section-heading-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-2xs);
    margin-inline-start: auto;
  }

  /* Quiet limitation note under a keyless (subscription-backed) source. */
  .keyless-source__limit {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-xs);
    margin: 0 0 var(--wa-space-xs);
    opacity: 0.85;
    font-size: var(--font-size-sm);
  }
  .keyless-source__limit wa-icon {
    flex: 0 0 auto;
    margin-top: var(--wa-space-3xs);
  }

  .category-section {
    margin-bottom: var(--wa-space-s);
  }

  @container settings (max-width: 520px) {
    .settings-section-heading-row {
      flex-wrap: wrap;
    }

    .settings-section-heading-actions {
      width: 100%;
      margin-inline-start: 0;
    }

    .settings-row {
      align-items: stretch;
      flex-direction: column;
      gap: var(--wa-space-xs);
    }

    .settings-row-control {
      justify-content: flex-start;
    }
  }
`;
