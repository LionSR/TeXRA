/**
 * Canonical control skins — the single definition of what a button, an input,
 * a focus ring, and a settings row look like in every TeXRA host.
 *
 * Four button skins (`.btn-primary` / `.btn-secondary` / `.btn-ghost` /
 * `.icon-button`), two modifiers (`.is-link` / `.is-danger`), two input skins
 * (`formControlStyles` / `.input-plain`). A surface that needs something else
 * belongs in this file, not in a local override — a per-component skin is how
 * hover ends up meaning three different things on one screen.
 *
 * Every value is a `var()`. Shadow roots adopt these sheets per component;
 * the desktop's light-DOM tree adopts the same sheets on its document
 * (`packages/desktop/src/renderer/designTokens.ts`), so both trees render
 * from this one definition.
 *
 * `.action-button` / `.action-icon-button` are selector aliases for the same
 * skins, kept because `renderIconActionButton` emits them and per-component
 * overrides target them.
 */

import { css, unsafeCSS, type CSSResult } from 'lit';

import { compactFormControlStyles } from './selectStyles';

/**
 * The six selector aliases that share the button skins — declared once so
 * the rules below cannot drift from each other.
 */
const INTERACTIVE_CONTROLS: CSSResult = unsafeCSS(
  '.btn-primary, .btn-secondary, .btn-ghost, .action-button, .icon-button, .action-icon-button',
);

/**
 * One focus ring for every interactive element in the shadow root.
 *
 * An `outline` follows the element's own `border-radius`, so a primitive that
 * carries no fill still needs a radius or its ring draws a hard rectangle.
 * `.focus-ring-inset` is for controls whose ring would be clipped by an
 * `overflow: hidden` ancestor (rows inside a scroller, tabs inside a strip).
 */
export const focusRingStyles: CSSResult = css`
  :focus-visible {
    outline: var(--focus-ring-width) solid var(--wa-color-focus);
    outline-offset: var(--focus-ring-offset);
  }

  .focus-ring-inset:focus-visible {
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }
`;

/**
 * Four button skins plus two modifiers.
 *
 *   .btn-primary    the one accent fill; at most one per view
 *   .btn-secondary  neutral fill with a quiet border
 *   .btn-ghost      transparent until hovered — the workhorse
 *   .icon-button    square, icon-only, sized by --control-size
 *   .is-link        on .btn-ghost: reads as a text link
 *   .is-danger      red text, never a red fill (that is dialog-only)
 *
 * Hover is a background fill, never an opacity fade: fill composes with the
 * translucent `--surface-*` overlays and therefore lands identically on every
 * surface in the ladder, which opacity does not.
 */
export const buttonStyles: CSSResult = css`
  /* Slotted text names the inner native button as well as the custom host. */
  .action-button-label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Native WA buttons and semantic skins share the same geometry. Without
     this reset, WA's font-relative height produces different sizes whenever
     a button inherits a caption, a section heading, or the body font. */
  wa-button {
    font-family: var(--font-family);
    font-size: var(--font-size);
    vertical-align: middle;
  }

  wa-button::part(base) {
    box-sizing: border-box;
    height: var(--height-button);
    min-height: var(--height-button);
    padding: 0 var(--control-padding-inline);
    border-radius: var(--field-radius);
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-normal);
    gap: 0;
  }

  /* Reset WA's slotted 0.75em margin; the part below owns icon/text spacing. */
  wa-button > [slot='start'],
  wa-button > [slot='end'] {
    margin-inline: 0;
  }

  /* Empty slots still occupy space in WA. Only populated slots get a gap,
     otherwise text-only buttons and icon-only actions become misaligned. */
  wa-button::part(start),
  wa-button::part(end) {
    margin-inline: 0;
  }

  wa-button:has(> [slot='start'])::part(start) {
    margin-inline-end: var(--wa-space-2xs);
  }

  wa-button:has(> [slot='end'])::part(end) {
    margin-inline-start: var(--wa-space-2xs);
  }

  .btn-primary::part(base),
  .btn-secondary::part(base) {
    min-height: var(--height-button);
    padding-inline: var(--control-padding-inline);
    border: var(--border-thin) solid transparent;
    border-radius: var(--border-radius-medium);
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
    transition:
      background-color var(--transition-normal),
      border-color var(--transition-normal),
      color var(--transition-normal),
      box-shadow var(--transition-normal);
  }

  :is(${INTERACTIVE_CONTROLS}) wa-icon {
    flex: 0 0 auto;
  }

  .btn-primary::part(base) {
    background: var(--wa-color-brand-fill-loud);
    color: var(--wa-color-brand-on-loud);
  }

  /* One step toward the label color rather than a fixed lighten: the accent is
     near-black in light mode and near-white in dark, so a single direction
     would wash out in one of the two themes. */
  .btn-primary::part(base):hover {
    background: color-mix(
      in srgb,
      var(--wa-color-brand-fill-loud) 92%,
      var(--wa-color-brand-on-loud)
    );
  }

  .btn-primary::part(base):active {
    background: color-mix(
      in srgb,
      var(--wa-color-brand-fill-loud) 84%,
      var(--wa-color-brand-on-loud)
    );
  }

  .btn-secondary::part(base) {
    border-color: var(--wa-form-control-border-color);
    background: var(--control-fill);
    color: var(--wa-color-text-normal);
  }

  .btn-secondary::part(base):hover {
    border-color: var(--wa-form-control-border-color);
    background: var(--control-fill-hover);
  }

  .btn-secondary::part(base):active {
    background: var(--surface-selected);
  }

  .btn-ghost,
  .action-button {
    flex-shrink: 0;
  }

  .btn-ghost::part(base),
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base) {
    gap: 0;
    min-height: var(--height-button);
    padding-inline: var(--control-padding-inline);
    border: var(--border-thin) solid transparent;
    border-radius: var(--border-radius-medium);
    background: transparent;
    font-size: var(--font-size);
    font-weight: var(--font-weight-normal);
    transition:
      background-color var(--transition-normal),
      border-color var(--transition-normal),
      color var(--transition-normal);
  }

  .btn-ghost::part(base):hover,
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base):hover {
    background: var(--surface-hover);
  }

  .btn-ghost::part(base):active,
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base):active {
    background: var(--surface-active);
  }

  /* A select button inside a row whose container owns hover/selection.
     Avoid a second filled rectangle inside the row. */
  .btn-ghost.is-row-content::part(base),
  .btn-ghost.is-row-content::part(base):is(:hover, :active) {
    background: transparent;
    border: 0;
    padding: 0 var(--wa-space-xs);
    min-height: var(--row-height);
    height: var(--row-height);
  }

  .btn-ghost wa-icon,
  .action-button wa-icon {
    font-size: var(--font-size-icon-sm);
  }

  /* Dense toolbars opt in together; a ghost action is not automatically
     shorter than the outlined button beside it. */
  .btn-ghost.is-compact::part(base),
  .action-button.is-compact::part(base) {
    height: var(--height-control-compact);
    min-height: var(--height-control-compact);
    font-size: var(--font-size-sm);
  }

  .icon-button,
  .action-icon-button {
    flex-shrink: 0;
    /* Toolbar actions share a square target, independently of label size. */
    --control-size: var(--control-size-s);
    width: var(--control-size);
    height: var(--control-size);
  }

  .icon-button {
    --control-size: var(--control-size-m);
  }

  .icon-button::part(base),
  .action-icon-button::part(base) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--control-size);
    min-width: 0;
    height: var(--control-size);
    min-height: 0;
    padding: 0;
    border: var(--border-thin) solid transparent;
    border-radius: var(--row-radius);
    background: transparent;
    color: var(--wa-color-text-quiet);
    transition:
      background-color var(--transition-fast),
      border-color var(--transition-fast),
      color var(--transition-fast);
  }

  .icon-button::part(label),
  .action-icon-button::part(label) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  .icon-button::part(base):hover,
  .action-icon-button::part(base):hover {
    background: var(--surface-hover);
    color: var(--wa-color-text-normal);
  }

  /* Pressed and toggled-on are the shared overlays, like every state. */
  .icon-button::part(base):active,
  .action-icon-button::part(base):active {
    background: var(--surface-active);
  }

  .icon-button[aria-pressed='true']::part(base),
  .action-icon-button[aria-pressed='true']::part(base) {
    background: var(--surface-selected);
    color: var(--wa-color-text-normal);
  }

  .icon-button wa-icon,
  .action-icon-button wa-icon {
    font-size: var(--font-size-icon-sm);
  }

  /* The three size steps. A caller picks one via the size option on
     renderIconActionButton (or the class directly); anything needing a fourth
     sets --control-size on the host rather than a width/height pair, so the
     radius and icon size stay in proportion. */
  .icon-button.is-size-s,
  .action-icon-button.is-size-s {
    --control-size: var(--control-size-s);
  }

  .icon-button.is-size-m,
  .action-icon-button.is-size-m {
    --control-size: var(--control-size-m);
  }

  .icon-button.is-size-l,
  .action-icon-button.is-size-l {
    --control-size: var(--control-size-l);
  }

  :is(
      .btn-primary,
      .btn-secondary,
      .btn-ghost,
      .action-button:not(.btn-primary):not(.btn-secondary),
      .icon-button,
      .action-icon-button
    )[disabled]::part(base) {
    cursor: not-allowed;
    opacity: 1;
    box-shadow: none;
  }

  .btn-primary[disabled]::part(base):is(:hover, :active) {
    background: var(--wa-color-brand-fill-loud);
  }

  .btn-secondary[disabled]::part(base):is(:hover, :active) {
    background: var(--control-fill);
  }

  :is(
      .btn-ghost,
      .action-button:not(.btn-primary):not(.btn-secondary),
      .icon-button,
      .action-icon-button
    )[disabled]::part(base):is(:hover, :active) {
    background: transparent;
    color: var(--wa-color-text-quiet);
  }

  .btn-ghost.is-link::part(base),
  .action-button.is-link::part(base) {
    height: auto;
    min-height: 0;
    padding: 0;
    background: transparent;
    color: var(--color-text-link);
    font-weight: var(--wa-font-weight-normal);
    /* Used inline in prose sentences, so underline at rest like a real link
       (hue alone is not a reliable 3:1 cue across host themes). */
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color var(--transition-fast);
  }

  .btn-ghost.is-link::part(base):hover,
  .action-button.is-link::part(base):hover {
    background: transparent;
    color: var(--color-text-link-active);
  }

  /* Destructive actions read as red text. A filled red button is reserved for
     the confirm step inside a dialog, where it is the only action. */
  .is-danger::part(base) {
    color: var(--color-error);
  }

  .is-danger::part(base):hover {
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    color: var(--color-error);
  }

  /* Primary composer action shared by the initial request and follow-up
     composers. The accessible label carries the host-specific verb; the
     visible affordance is deliberately identical. */
  .action-icon-button.composer-primary-action {
    margin-inline-start: auto;
  }

  /* Send is the view's primary action, so it wears the one accent fill that
     .btn-primary wears (the editor's button color in VS Code). */
  .action-icon-button.composer-primary-action::part(base) {
    border-radius: var(--field-radius);
    background: var(--wa-color-brand-fill-loud);
    color: var(--wa-color-brand-on-loud);
  }

  .action-icon-button.composer-primary-action::part(base):hover {
    background: var(--wa-color-button-hover, var(--wa-color-brand-fill-loud));
    color: var(--wa-color-brand-on-loud);
  }

  .action-icon-button.composer-primary-action[disabled]::part(base):is(
      :hover,
      :active
    ) {
    background: var(--wa-color-brand-fill-loud);
    color: var(--wa-color-brand-on-loud);
  }
`;

/**
 * Bordered surface for a decorative leading icon.
 *
 * This is deliberately separate from `.icon-button`: it is presentation, not
 * an interactive target, so it has no hover/focus/pressed states. The shared
 * size classes let call sites align decorative icons with adjacent controls
 * without repeating one-off width/height/radius declarations.
 */
export const iconSurfaceStyles: CSSResult = css`
  .icon-surface {
    --icon-surface-size: var(--control-size-m);
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: var(--icon-surface-size);
    height: var(--icon-surface-size);
    border: var(--border-thin) solid var(--border-hairline);
    border-radius: var(--row-radius);
    background: var(--control-fill);
    color: var(--wa-color-text-quiet);
  }

  .icon-surface wa-icon {
    width: 1em;
    min-width: 1em;
    height: 1em;
    min-height: 1em;
    font-size: var(--font-size-icon-sm);
  }

  .icon-surface.is-size-s {
    --icon-surface-size: var(--control-size-s);
  }

  .icon-surface.is-size-m {
    --icon-surface-size: var(--control-size-m);
  }

  .icon-surface.is-size-l {
    --icon-surface-size: var(--control-size-l);
  }

  .icon-surface.is-size-l wa-icon {
    font-size: var(--font-size-icon);
  }
`;

/**
 * Both input skins.
 *
 * The default skin covers `wa-input` / `wa-select` (via
 * {@link compactFormControlStyles}) and adds `wa-textarea`, which was absent —
 * which is why six textareas hand-rolled their sizing and why the instruction
 * panel's rendered mono while the follow-up input's rendered sans.
 *
 * `.input-plain` is the deliberate second skin: no box, one bottom hairline,
 * larger type. It is for a search field that owns its whole band (the command
 * palette, the history/memory search wells), where a bordered control would
 * read as a widget floating inside a panel.
 */
export const formControlStyles: CSSResult = css`
  ${compactFormControlStyles}

  .inline-rename {
    box-sizing: border-box;
    min-width: 0;
    height: var(--height-control-compact);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    border: var(--border-thin) solid var(--wa-form-control-border-color);
    border-radius: var(--field-radius);
    background: var(--wa-form-control-background-color);
    color: var(--wa-color-text-normal);
    font: inherit;
  }

  .inline-rename:focus {
    outline: none;
    border-color: var(--wa-color-focus);
    box-shadow: var(--field-focus-halo);
  }

  wa-textarea::part(base) {
    min-height: var(--textarea-min-height, var(--textarea-h-m));
    border: var(--border-thin) solid var(--wa-form-control-border-color);
  }

  wa-textarea::part(textarea) {
    max-height: var(--textarea-max-height, 13rem);
    padding-block: var(--wa-space-xs);
    padding-inline: var(--control-padding-inline);
    font-family: var(--font-family);
    font-size: var(--font-size);
    line-height: var(--line-height-normal);
  }

  /* One option-row definition, sized by the host's own bridge token. The
     fallback is the desktop's roomier row; the extension overrides it at
     :root, which reaches here because the token is not re-declared on
     :host. */
  wa-option::part(base) {
    min-height: var(--wa-height-option, 32px);
    padding: var(--wa-space-3xs) var(--wa-space-xs);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  /* Dropdown items render the row on their host, with no "base" part.
     Icons have a square canvas; glyph width must never move the label. */
  wa-dropdown-item {
    box-sizing: border-box;
    min-height: var(--row-height);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border-radius: var(--row-radius);
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  wa-dropdown-item > [slot='icon'] {
    flex: 0 0 var(--font-size-icon-sm);
    width: var(--font-size-icon-sm);
    height: var(--font-size-icon-sm);
    font-size: var(--font-size-icon-sm);
  }

  /* Web Awesome draws checkmarks into a reserved leading gutter. Preserve
     that gutter when applying the shared row padding, including normal items
     next to checkbox items so their labels remain aligned. */
  wa-dropdown-item[checkbox-adjacent],
  wa-dropdown-item[type='checkbox'] {
    padding-inline-start: calc(var(--wa-space-xs) + 1.5em);
  }

  wa-dropdown-item::part(checkmark) {
    flex: none;
    inline-size: 1em;
    block-size: 1em;
    font-size: inherit;
    margin-inline-start: -1.5em;
    margin-inline-end: 0.5em;
  }

  wa-dropdown-item::part(submenu-icon) {
    inset-inline-end: var(--wa-space-xs);
  }

  /* Makes a form control fill its row. The min-width reset is the load-bearing
     part — a wa-input's intrinsic min-width otherwise overflows a flex row
     instead of shrinking. */
  .form-control-fill {
    flex: 1;
    width: 100%;
    min-width: 0;
  }

  .input-plain::part(base) {
    min-height: var(--height-header);
    border: 0;
    border-bottom: var(--border-thin) solid var(--border-hairline);
    border-radius: 0;
    background: transparent;
  }

  .input-plain::part(input) {
    padding-inline: var(--wa-space-m);
    font-size: var(--font-size-lg);
  }
`;

/**
 * The settings row primitive: label (plus optional help text) on the left, the
 * control on the right, a hairline between adjacent rows, and nothing else — no
 * per-row card, no per-row radius, no per-row background.
 *
 * Reaches the settings tabs through `commonViewStyles`, which every tab already
 * adopts. Settings tabs use this one hierarchy instead of defining local row
 * or block variants.
 */
export const settingsRowStyles: CSSResult = css`
  .settings-section {
    margin-block-end: var(--wa-space-m);
  }

  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-m);
    padding-block: var(--wa-space-xs);
  }

  /* Only separate peer rows. A following card, disclosure, or custom element
     owns its own boundary; a row must not add a second line around it. */
  .settings-row + .settings-row {
    border-block-start: var(--border-thin) solid var(--border-hairline);
  }

  .settings-row.is-compact {
    padding-block: var(--wa-space-2xs);
  }

  .settings-row-text {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-3xs);
    min-width: 0;
  }

  .settings-row-label {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
  }

  .settings-row-label > wa-icon {
    flex: 0 0 var(--font-size-icon-sm);
    width: var(--font-size-icon-sm);
    height: var(--font-size-icon-sm);
  }

  .settings-row-help {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    line-height: var(--line-height-relaxed);
  }

  /* Centred against the whole text block, not against its first line. */
  .settings-row-control {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    align-self: center;
    gap: var(--wa-space-xs);
    min-width: 0;
    max-width: 52%;
  }

  .settings-row-control > :is(wa-input, wa-select, wa-textarea) {
    min-width: 0;
    max-width: 100%;
  }

  .settings-row.is-toggle wa-switch::part(label) {
    margin-inline-start: 0;
  }

  @container settings (max-width: 520px) {
    .settings-row:not(.is-toggle) {
      align-items: stretch;
      flex-direction: column;
      gap: var(--wa-space-xs);
    }

    .settings-row:not(.is-toggle) .settings-row-control {
      align-self: flex-start;
      max-width: 100%;
      flex-wrap: wrap;
    }
  }

  /* Skins for the hooks renderSettingsNumberRow hardcodes. They live here
     rather than per-tab because every tab is its own shadow root and the
     helper emits the classes for any caller. A tab that needs a different
     width still overrides locally (latex-tab does). */
  .setting-number-input {
    width: 80px;
  }

  .setting-unit {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
`;
