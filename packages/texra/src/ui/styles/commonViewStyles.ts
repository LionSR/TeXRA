import { css, type CSSResult } from 'lit';
import { noticeStyles } from './surfaceStyles';
import { placeholderStyles } from '@ui/wa/emptyState';

import {
  buttonStyles,
  focusRingStyles,
  formControlStyles,
  iconSurfaceStyles,
  settingsRowStyles,
} from './controlStyles';

/**
 * {@link visuallyHiddenStyles} without its selector, for rules that cannot use
 * the class: Web Awesome exposes form-control labels and hints as shadow
 * parts, so a view hiding one writes its own `::part(...)` rule against an
 * element it cannot add a class to. Interpolate this rather than restate it.
 */
export const visuallyHiddenDeclarations: CSSResult = css`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
`;

/**
 * Available to the accessibility tree, absent from the layout. Exported on
 * its own (and interpolated into `commonViewStyles` below) for roots that
 * compose a narrower sheet and so do not take the full common one.
 * `.has-hidden-label` does the same for a Web Awesome control's `label`, so
 * the label still names the control's inner input.
 */
export const visuallyHiddenStyles: CSSResult = css`
  .visually-hidden,
  .has-hidden-label::part(form-control-label) {
    ${visuallyHiddenDeclarations}
  }
`;

/**
 * The small-caps label over a group of rows (a run-list section, a menu
 * group, a palette group): one type treatment wherever a list is grouped.
 * Interpolate it into the rule that places the label; the desktop's light
 * DOM uses {@link overlineStyles}.
 */
export const overlineDeclarations: CSSResult = css`
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--letter-spacing-caps);
  text-transform: uppercase;
  color: var(--color-text-secondary);
`;

/**
 * One line cut with an ellipsis: a name, path or title that must neither wrap
 * nor push the rest of its row away. Interpolate it into the rule that places
 * the text; a flex item still sets its own `min-width` and basis.
 */
export const truncateDeclarations: CSSResult = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/** {@link overlineDeclarations} as a class, for a tree that adopts sheets
 *  rather than composing rules (the desktop's light DOM). */
export const overlineStyles: CSSResult = css`
  .overline {
    ${overlineDeclarations}
  }
`;

/** {@link truncateDeclarations} as a class, for the desktop's light DOM. */
export const truncateStyles: CSSResult = css`
  .truncate {
    ${truncateDeclarations}
  }
`;

/**
 * The chevron of a disclosure: it turns to point down while the control
 * around it (anything carrying `aria-expanded`) is open.
 */
export const disclosureChevronStyles: CSSResult = css`
  .disclosure-chevron {
    display: inline-grid;
    width: 1em;
    height: 1em;
    flex: 0 0 1em;
    place-items: center;
    color: var(--color-text-secondary);
  }

  @media (prefers-reduced-motion: no-preference) {
    .disclosure-chevron {
      transition: transform var(--transition-fast);
    }
  }

  [aria-expanded='true'] .disclosure-chevron {
    transform: rotate(90deg);
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
    font-size: var(--font-size-icon);
    pointer-events: none;
  }
`;

/**
 * The one drag-over skin for a file drop target driven by `FileDropController`:
 * the target takes `.is-drag-active` while files are over it, and may render
 * a `.drop-cue` naming what the drop does. The target needs
 * `position: relative` when it renders the cue.
 */
export const dropTargetStyles: CSSResult = css`
  .is-drag-active {
    outline: var(--border-medium) dashed var(--wa-color-brand-fill-loud);
    outline-offset: calc(-1 * var(--border-medium));
    background: color-mix(
      in srgb,
      var(--wa-color-brand-fill-quiet) 22%,
      transparent
    );
  }

  .drop-cue {
    position: absolute;
    inset: var(--wa-space-3xs);
    z-index: var(--layer-pinned);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--border-radius);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-default) 78%,
      transparent
    );
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    pointer-events: none;
  }
`;

export const commonViewStyles: CSSResult = css`
  ${noticeStyles}

  .list-item {
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius-large);
    padding: var(--wa-space-xs);
    background-color: var(--wa-color-surface-default);
  }

  .list-item:hover {
    background-color: var(--surface-hover);
  }

  .settings-disclosure-list {
    display: grid;
    gap: 0;
    border-block: var(--border-thin) solid var(--color-border);
  }

  /* Single-open disclosure pattern: consumers (ModelSelectionList,
     ProviderKeyList) keep exactly one item expanded at a time, closing the
     previous one when a new summary opens. The toggling lives in each
     component (it's a few lines of state, not worth a shared mixin), but new
     surfaces should copy the same one-open invariant rather than allowing
     independent <details>-style toggles. */
  .settings-disclosure {
    overflow: hidden;
    border-block-end: var(--border-thin) solid var(--color-border);
    background: var(--wa-color-surface-default);
  }

  .settings-disclosure:last-child {
    border-block-end: 0;
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
    height: auto;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
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

  ${disclosureChevronStyles}

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
    background: var(--color-bg-secondary);
  }

  .list-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  /* The primitive owns one frame. Host borders would sit outside WA's own
     rounded base and create stray rules above and below the same panel. */
  .panel-collapsible::part(base) {
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-default);
  }

  .panel-collapsible::part(header) {
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    background-color: var(--color-bg-secondary);
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
    font-weight: var(--font-weight-normal);
    color: var(--color-text-secondary);
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
  ${placeholderStyles}

  wa-checkbox,
  wa-radio,
  wa-switch {
    font-size: var(--font-size);
  }

  wa-checkbox::part(label),
  wa-radio::part(label),
  wa-switch::part(label) {
    font-size: var(--font-size);
    padding-inline-start: 0;
    line-height: var(--line-height-normal);
  }

  wa-checkbox::part(base),
  wa-radio::part(base),
  wa-switch::part(base) {
    align-items: center;
    gap: var(--wa-space-xs);
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

  /* A link that runs an action is a native button inside the sentence (a
     wa-button is inline-flex and would break the line); drop its box. */
  button.clickable-link {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
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

  .tab-content-container > section + section {
    margin-block-start: var(--wa-space-l);
  }

  .settings-section-heading {
    display: grid;
    gap: var(--wa-space-3xs);
    margin: 0 0 var(--wa-space-xs);
    padding-bottom: var(--wa-space-2xs);
  }

  .settings-section-heading-row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-width: 0;
  }

  .settings-section-heading-icon {
    display: var(--settings-section-icon-display, grid);
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    place-items: center;
    color: var(--color-text-secondary);
    font-size: var(--font-size);
  }

  .settings-section-heading-title {
    margin: 0;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
  }

  .settings-section-heading-description {
    max-width: 72ch;
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
  }

  .settings-section-heading-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-xs);
    margin-inline-start: auto;
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

    .settings-row-control {
      justify-content: flex-start;
    }
  }
`;
