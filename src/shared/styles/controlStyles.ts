/**
 * Canonical control skins — the single definition of what a button, an input,
 * a focus ring, and a settings row look like in every TeXRA host.
 *
 * Before this file each surface rolled its own: 18 distinct `wa-button` skins
 * across the extension and the desktop renderer, three competing hover
 * languages (opacity / fill / both), 21 hand-written focus rings at four
 * different widths, and six textareas that each hardcoded their own height.
 * The skins below collapse that to four button skins, two modifiers, and two
 * input skins.
 *
 * Every value is a `var()`, so the desktop's light-DOM mirror in
 * `packages/desktop/src/renderer/styles.css` cannot drift in appearance from
 * this sheet — only in existence. Shadow DOM can't adopt a document
 * stylesheet, and light DOM can't adopt a Lit `CSSResult`, which is why the
 * class names exist in both places.
 *
 * Legacy class names (`.action-button`, `.action-icon-button`, `.header-action`)
 * are kept as selector aliases rather than renamed at ~40 call sites: the skin
 * has one definition either way, and per-component overrides that target the
 * legacy names keep resolving.
 */

import { css, type CSSResult } from 'lit';

import { compactFormControlStyles } from './selectStyles';

/**
 * One focus ring for every interactive element in the shadow root.
 *
 * Replaces 21 hand-written rings (17 at 1px, two at 2px, two inset at -1px).
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
 *   .btn-secondary  neutral fill, no border
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
  .btn-primary::part(base),
  .btn-secondary::part(base) {
    min-height: var(--height-button);
    padding-inline: var(--wa-space-m);
    border: 0;
    border-radius: var(--border-radius-medium);
    font-weight: var(--font-weight-medium);
    transition: background-color var(--transition-fast);
  }

  :is(
      .btn-primary,
      .btn-secondary,
      .btn-ghost,
      .action-button,
      .header-action,
      .icon-button,
      .action-icon-button
    )
    wa-icon {
    flex: 0 0 auto;
    width: 1em;
    height: 1em;
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
    background: var(--control-fill);
    color: var(--wa-color-text-normal);
  }

  .btn-secondary::part(base):hover {
    background: var(--control-fill-hover);
  }

  .btn-secondary::part(base):active {
    background: var(--surface-selected);
  }

  .btn-ghost,
  .action-button,
  .header-action {
    flex-shrink: 0;
  }

  .btn-ghost::part(base),
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base),
  .header-action::part(base) {
    gap: var(--wa-space-2xs);
    min-height: var(--height-control-compact);
    padding-inline: var(--control-padding-inline);
    border: 0;
    border-radius: var(--border-radius-medium);
    background: transparent;
    font-size: var(--font-size-sm);
    transition: background-color var(--transition-fast);
  }

  .btn-ghost::part(base):hover,
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base):hover,
  .header-action::part(base):hover {
    background: var(--surface-hover);
  }

  .btn-ghost::part(base):active,
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base):active,
  .header-action::part(base):active {
    background: var(--surface-active);
  }

  .btn-ghost wa-icon,
  .action-button wa-icon {
    font-size: var(--font-size-sm);
  }

  .icon-button,
  .action-icon-button {
    flex-shrink: 0;
    /* Legacy compact toolbars keep the small step; .icon-button callers get
       the 28px default and can opt into any step via --control-size. */
    --control-size: var(--control-size-s);
  }

  .icon-button {
    --control-size: var(--control-size-m);
  }

  .icon-button::part(base),
  .action-icon-button::part(base) {
    width: var(--control-size);
    min-width: 0;
    height: var(--control-size);
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: var(--row-radius);
    background: transparent;
    color: var(--wa-color-text-quiet);
    transition:
      background-color var(--transition-fast),
      color var(--transition-fast);
  }

  .icon-button::part(base):hover,
  .action-icon-button::part(base):hover {
    background: var(--surface-hover);
    color: var(--wa-color-text-normal);
  }

  .icon-button::part(base):active,
  .action-icon-button::part(base):active,
  .icon-button[aria-pressed='true']::part(base),
  .action-icon-button[aria-pressed='true']::part(base) {
    background: var(--surface-selected);
    color: var(--wa-color-text-normal);
  }

  .icon-button wa-icon,
  .action-icon-button wa-icon {
    font-size: var(--font-size-icon-sm);
  }

  /* Size steps for the icon button. Six former hardcoded geometries (20/22/24/
     28/32/40px) collapse onto these three. */
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
      .header-action,
      .icon-button,
      .action-icon-button
    )[disabled]::part(base) {
    cursor: not-allowed;
    opacity: var(--opacity-disabled);
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
      .action-button,
      .header-action,
      .icon-button,
      .action-icon-button
    )[disabled]::part(base):is(:hover, :active) {
    background: transparent;
    color: var(--wa-color-text-quiet);
  }

  .btn-ghost.is-link::part(base),
  .action-button.is-link::part(base) {
    min-height: 0;
    padding: 0;
    background: transparent;
    color: var(--color-text-link);
  }

  .btn-ghost.is-link::part(base):hover,
  .action-button.is-link::part(base):hover {
    background: transparent;
    color: var(--color-text-link-active);
    text-decoration: underline;
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

  wa-textarea::part(base) {
    min-height: var(--textarea-min-height, var(--textarea-h-m));
    border: var(--border-thin) solid var(--wa-form-control-border-color);
  }

  wa-textarea::part(textarea) {
    max-height: var(--textarea-max-height, 13rem);
    padding-block: 1px;
    padding-inline: var(--control-padding-inline);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  /* One option-row definition. It was declared three times at three heights
     (the extension bridge, the desktop bridge, and this sheet); each host now
     sets --wa-height-option once instead. */
  wa-option::part(base),
  wa-dropdown-item::part(base) {
    min-height: var(--wa-height-option);
    padding: var(--wa-space-3xs) var(--wa-space-xs);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  /* Replaces five width-only rules that each re-declared the same three
     declarations to make a control fill its row. */
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
 * Split button: a labeled action fused to a caret that opens its menu.
 *
 * Extracted from two ~90-line byte-identical copies (`ApproveSplitButton` and
 * the tool-edit diff dropdown). Both call sites carry these class names
 * alongside their own prefixed ones, which they keep because their tests and
 * per-panel width rules query them.
 *
 * Consumers set `--split-accent` to tint both halves (approve uses success);
 * it defaults to `currentColor` so an untinted split button just inherits.
 * The host is expected to own the width budget — `.split-button` fills its
 * container, so cap it on the container, not here.
 */
export const splitButtonStyles: CSSResult = css`
  .split-button {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    width: 100%;
    min-width: 0;
  }

  .split-button-main {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* Square the inner corners so label and caret fuse into one pill. */
  .split-button-main::part(base) {
    width: 100%;
    min-width: 0;
    justify-content: center;
    color: var(--split-accent, currentColor);
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }

  /* Pull the caret onto the label so their borders overlap into a single
     divider instead of a doubled line once they appear on hover. */
  .split-button-menu {
    flex: 0 0 auto;
    display: inline-flex;
    margin-inline-start: calc(-1 * var(--border-thin));
  }

  .split-button-trigger {
    flex: 0 0 auto;
    width: 1.5rem;
    min-width: 1.5rem;
  }

  /* Borderless at rest with the border reserved (transparent) so nothing
     shifts when it appears, and only the trailing corners rounded so the caret
     tucks against the label. */
  .split-button-trigger::part(base) {
    width: 100%;
    height: auto;
    min-height: var(--height-control-compact);
    padding: 0;
    background: transparent;
    color: var(--split-accent, currentColor);
    border: var(--border-thin) solid transparent;
    border-start-start-radius: 0;
    border-end-start-radius: 0;
  }

  .split-button-trigger::part(base):hover {
    background: var(--surface-hover);
  }

  .split-button-trigger wa-icon {
    font-size: var(--font-size-sm);
  }

  /* Hovering or opening either half outlines the pair as one box with a single
     internal divider, so the caret reads as the label's menu rather than a
     stray glyph beside it. */
  .split-button:hover .split-button-main::part(base),
  .split-button:hover .split-button-trigger::part(base),
  .split-button:focus-within .split-button-main::part(base),
  .split-button:focus-within .split-button-trigger::part(base),
  .split-button wa-dropdown[open] .split-button-main::part(base),
  .split-button wa-dropdown[open] .split-button-trigger::part(base) {
    border-color: var(--border-hairline);
  }

  .split-button wa-dropdown[open] .split-button-trigger wa-icon {
    transform: rotate(180deg);
  }
`;

/**
 * The settings row primitive: label (plus optional help text) on the left, the
 * control on the right, a hairline between rows, and nothing else — no
 * per-row card, no per-row radius, no per-row background.
 *
 * Reaches the settings tabs through `commonViewStyles`, which every tab already
 * adopts. It supersedes the two `.setting-row` and four `.setting-block` local
 * copies (byte-identical apart from spacing drift); retiring those call sites
 * belongs to the settings-hierarchy workstream that owns those files.
 */
export const settingsRowStyles: CSSResult = css`
  .settings-section {
    margin-block-end: var(--wa-space-l);
  }

  .settings-section-title {
    margin-block: var(--wa-space-l) var(--wa-space-2xs);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-quiet);
  }

  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--wa-space-m);
    padding-block: var(--wa-space-s);
    border-block-end: var(--border-thin) solid var(--border-hairline);
  }

  .settings-row:last-child {
    border-block-end: 0;
  }

  .settings-row-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .settings-row-label {
    font-size: var(--font-size);
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
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
    gap: var(--wa-space-2xs);
  }
`;
