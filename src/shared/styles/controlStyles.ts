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
 * Every value is a `var()`, so the desktop's light-DOM mirror in
 * `packages/desktop/src/renderer/styles.css` cannot drift in appearance from
 * this sheet — only in existence. Shadow DOM can't adopt a document
 * stylesheet, and light DOM can't adopt a Lit `CSSResult`, which is why the
 * class names exist in both places.
 *
 * `.action-button` / `.action-icon-button` / `.header-action` are selector
 * aliases for the same skins, kept because `renderIconActionButton` emits them
 * and per-component overrides target them.
 */

import { css, type CSSResult } from 'lit';

import { compactFormControlStyles } from './selectStyles';

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
  .btn-primary::part(base),
  .btn-secondary::part(base) {
    min-height: var(--height-button);
    padding-inline: var(--wa-space-m);
    border: var(--border-thin) solid transparent;
    border-radius: var(--border-radius-medium);
    font-weight: var(--font-weight-medium);
    transition:
      background-color var(--transition-normal),
      border-color var(--transition-normal),
      color var(--transition-normal),
      box-shadow var(--transition-normal);
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
    border-color: var(--border-hairline-strong);
    background: var(--control-fill);
    color: var(--wa-color-text-normal);
  }

  .btn-secondary::part(base):hover {
    border-color: color-mix(
      in srgb,
      var(--wa-color-focus) 38%,
      var(--border-hairline-strong)
    );
    background: color-mix(
      in srgb,
      var(--wa-color-brand-fill-quiet) 40%,
      var(--control-fill-hover)
    );
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
    border: var(--border-thin) solid transparent;
    border-radius: var(--border-radius-medium);
    background: transparent;
    font-size: var(--font-size-sm);
    transition:
      background-color var(--transition-normal),
      border-color var(--transition-normal),
      color var(--transition-normal);
  }

  .btn-ghost::part(base):hover,
  .action-button:not(.btn-primary):not(.btn-secondary)::part(base):hover,
  .header-action::part(base):hover {
    border-color: var(--border-hairline);
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
    border-color: var(--border-hairline);
    background: var(--surface-hover);
    color: var(--wa-color-text-normal);
  }

  .icon-button::part(base):active,
  .action-icon-button::part(base):active,
  .icon-button[aria-pressed='true']::part(base),
  .action-icon-button[aria-pressed='true']::part(base) {
    border-color: color-mix(
      in srgb,
      var(--wa-color-focus) 34%,
      var(--border-hairline)
    );
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-text-normal);
  }

  :is(
    .btn-primary,
    .btn-secondary,
    .btn-ghost,
    .action-button,
    .header-action,
    .icon-button,
    .action-icon-button
  ):not([disabled]) {
    transition:
      filter var(--transition-normal),
      transform var(--transition-normal);
  }

  :is(
      .btn-primary,
      .btn-secondary,
      .btn-ghost,
      .action-button,
      .header-action,
      .icon-button,
      .action-icon-button
    ):not([disabled]):hover {
    transform: translateY(-1px);
  }

  :is(
      .btn-primary,
      .btn-secondary,
      .btn-ghost,
      .action-button,
      .header-action,
      .icon-button,
      .action-icon-button
    ):not([disabled]):active {
    transform: translateY(0) scale(0.97);
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

  :is(.btn-ghost.is-link, .action-button.is-link):is(:hover, :active) {
    transform: none;
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

  .action-icon-button.composer-primary-action::part(base) {
    border-radius: var(--wa-border-radius-circle);
    background: var(--wa-color-text-normal);
    color: var(--wa-color-surface-default);
  }

  .action-icon-button.composer-primary-action::part(base):hover {
    background: color-mix(
      in srgb,
      var(--wa-color-text-normal) 86%,
      var(--wa-color-surface-default)
    );
    color: var(--wa-color-surface-default);
  }

  .action-icon-button.composer-primary-action[disabled]::part(base):is(
      :hover,
      :active
    ) {
    background: var(--wa-color-text-normal);
    color: var(--wa-color-surface-default);
  }

  @media (prefers-reduced-motion: reduce) {
    :is(
        .btn-primary,
        .btn-secondary,
        .btn-ghost,
        .action-button,
        .header-action,
        .icon-button,
        .action-icon-button
      ):not([disabled]):is(:hover, :active) {
      transform: none;
    }
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

  /* One option-row definition, sized by the host's own bridge token. The
     fallback is the desktop's roomier row; the extension overrides it at
     :root, which reaches here because the token is not re-declared on
     :host. */
  wa-option::part(base),
  wa-dropdown-item::part(base) {
    min-height: var(--wa-height-option, 32px);
    padding: var(--wa-space-3xs) var(--wa-space-xs);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
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
 * control on the right, a hairline between rows, and nothing else — no
 * per-row card, no per-row radius, no per-row background.
 *
 * Reaches the settings tabs through `commonViewStyles`, which every tab already
 * adopts. Settings tabs use this one hierarchy instead of defining local row
 * or block variants.
 */
export const settingsRowStyles: CSSResult = css`
  .settings-section {
    margin-block-end: var(--wa-space-l);
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
