import { css, type CSSResult } from 'lit';

/**
 * The one definition of the semantic tokens every host renders with. It
 * matches `:root` as well as `:host`, so a host adopts it once on its
 * document for light DOM and every component adopts it for its shadow root;
 * hosts set only the `--wa-*` inputs and colors these read.
 */
export const designTokens: CSSResult = css`
  :root,
  :host {
    /* Text colors */
    --color-text-secondary: var(--wa-color-text-quiet);
    --color-text-link: var(--wa-color-text-link, #3794ff);
    --color-text-link-active: var(--wa-color-text-link-active);

    /* Background colors */
    --color-bg-secondary: var(--wa-color-surface-lowered);

    /* Border colors */
    --color-border: var(--wa-color-surface-border);

    /* Status colors */
    --color-success: var(--wa-color-success-on-quiet, #2ea043);
    --color-error: var(--wa-color-danger-on-quiet, #f14c4c);
    --color-warning: var(--wa-color-warning-on-quiet, #cca700);
    --color-info: var(--wa-color-chart-blue, #3794ff);
    --color-added: var(--wa-color-chart-green, #4caf50);
    --color-removed: var(--wa-color-chart-red, #f44336);
    --color-chart-orange: var(--wa-color-chart-orange, #d18616);

    /* Status indicators (dependency installed/missing, tool available/missing).
       Distinct from --color-success/--color-error: these use the editor
       "testing" palette so green/salmon status icons match the host theme. */
    --color-status-ok: var(--wa-color-testing-passed, #73c991);
    --color-status-error: var(--wa-color-testing-failed, #f48771);

    /* In-progress / pending accent (running-tool spinner, timers). */
    --color-pending: var(--wa-color-chart-yellow, #cca700);

    /* Diff foreground colors (added/removed/modified lines in tool diffs). */
    --color-diff-added: var(--wa-color-git-added, #3fb950);
    --color-diff-removed: var(--wa-color-git-deleted, #f85149);
    --color-diff-modified: var(--wa-color-git-modified, #d29922);

    /* Component aliases */
    --background-color: var(--color-bg-secondary);
    --text-color: var(--wa-color-text-normal);
    --button-hover-background: var(--wa-color-button-hover);
    --dropdown-border: var(--wa-form-control-border-color);

    /* Typography */
    --font-size: var(--wa-font-size-m);
    --font-family: var(--wa-font-family-body);
    --font-weight: var(--wa-font-weight-normal);
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --font-size-lg: var(--wa-type-large, calc(var(--font-size) * 1.2));
    --font-size-sm: var(--wa-type-small, calc(var(--font-size) * 0.9));
    --font-size-xs: var(--wa-type-caption, calc(var(--font-size) * 0.8));
    --font-size-icon: var(--font-size-lg);
    --font-size-icon-sm: var(--wa-icon-size, var(--font-size));
    --font-size-reading: var(--wa-type-reading, var(--font-size));

    /* Heading scale shared with desktop themeTokens.css. Use these tokens
       instead of hardcoded heading sizes so extension and desktop hosts
       render headings at the same visual scale. */
    --font-size-h1: var(--wa-type-title, 1.5em);
    --font-size-h2: var(--wa-type-heading, 1.25em);
    --font-size-h3: var(--wa-type-section, 1em);
    --line-height-tight: 1;
    --line-height-heading: 1.25;
    --line-height-normal: 1.5;
    --line-height-relaxed: 1.5;

    /* Both hosts supply the radius scale; do not introduce local fallbacks. */
    --border-radius: var(--wa-border-radius-s);
    --border-radius-medium: var(--wa-border-radius-m);
    --border-radius-large: var(--wa-border-radius-l);
    /* Alias, not a step: it resolved to the same value as --border-radius and
       the two names drifting apart is the failure mode worth preventing. */
    --border-radius-small: var(--border-radius);

    /* Heights. Also host-overridable: the desktop app runs roomier controls
       than a sidebar-width editor panel can afford. */
    --height-control: var(--wa-height-control, 24px);
    --height-control-compact: var(--wa-height-control-compact, 22px);
    /* Shared height for the Progress view's pane headers — the conversation
       header and the run-tabs rail header pin to this so the two panes
       start their content at the same baseline (and match the desktop rail). */
    --height-header: var(--wa-height-header, 34px);
    --height-button: var(--wa-height-button, 30px);
    --height-small: 100px;
    --height-large: 300px;
    --height-xlarge: 400px;

    /* Widths */
    --width-button-min: 80px;

    /* Borders */
    --border-thin: 1px;
    --border-medium: 2px;

    /* State overlays. Every hover/active/selected state in the app is one of
       these three translucent overlays on a background-color-only transition —
       never a new hue, never a border, never movement. Translucency is what
       makes one token correct on every surface in the ladder; the light and
       dark alphas differ because the same alpha does not read as the same step
       against paper-white and charcoal. */
    --surface-hover: var(
      --wa-surface-hover,
      light-dark(rgb(0 0 0 / 7%), rgb(255 255 255 / 15%))
    );
    --surface-active: var(
      --wa-surface-active,
      light-dark(rgb(0 0 0 / 5%), rgb(255 255 255 / 10%))
    );
    --surface-selected: var(
      --wa-surface-selected,
      light-dark(rgb(0 0 0 / 9%), rgb(255 255 255 / 12%))
    );

    /* Metadata is still text: use the host's readable secondary foreground,
       rather than fading primary text below normal-text contrast. */
    --color-text-muted: var(--wa-color-text-quiet);
    /* Control boundaries have a separate, non-text contrast requirement. */
    --border-control: color-mix(
      in srgb,
      var(--wa-color-text-normal) 55%,
      transparent
    );

    /* Seams. Alpha hairlines for the places a border is load-bearing (settings
       rows, code blocks, inputs); large regions separate by a background step
       instead. */
    --border-hairline: light-dark(rgb(0 0 0 / 10%), rgb(255 255 255 / 10%));
    --border-hairline-strong: light-dark(
      rgb(0 0 0 / 15%),
      rgb(255 255 255 / 20%)
    );

    /* Control geometry, consumed by controlStyles.ts.

       The host-varying steps read a --wa-* bridge token with the desktop
       value as the fallback, the same shape as --height-control above. A bare
       value here would be unreachable by a host: :host beats an inherited
       :root declaration for the whole shadow subtree, and these webviews are
       a single Lit root, so a host that wants tighter chrome has to be able to
       reach in. Only the steps that actually differ per host take the
       indirection. */
    --control-size-s: var(--wa-control-size-s, 24px);
    --control-size-m: var(--wa-control-size-m, 28px);
    --control-size-l: var(--wa-control-size-l, 32px);
    --control-padding-inline: var(--wa-control-padding-inline, 6px);
    /* The field (input, select, textarea, composer): one radius and one focus
       treatment everywhere. Focus colors the border and adds a halo inside
       the field's own footprint; the extension keeps a 1px ring, the desktop
       a soft wider one. */
    --field-radius: var(--wa-form-control-border-radius, var(--border-radius));
    --field-focus-halo: var(
      --wa-field-focus-halo,
      0 0 0 1px var(--wa-color-focus)
    );
    --control-fill: light-dark(rgb(0 0 0 / 5%), rgb(255 255 255 / 5%));
    --control-fill-hover: light-dark(rgb(0 0 0 / 8%), rgb(255 255 255 / 9%));
    --row-height: var(--wa-row-height, 36px);
    --row-radius: var(--border-radius-medium);
    --row-padding: var(--wa-row-padding, 6px 10px);
    /* One density contract for content panels, independent of their contents. */
    --panel-padding-inline: var(--wa-space-s);
    --panel-padding-block: var(--wa-space-xs);
    --panel-gap: var(--wa-space-2xs);
    --panel-radius: var(--border-radius-large);
    --panel-background: var(--wa-color-surface-lowered);
    --message-gap: var(--wa-space-s);
    /* Not host-varying, deliberately: one ring width everywhere. A 1px ring is
       the kind of thing that reads as tidy and fails a low-vision user. */
    --focus-ring-width: 2px;
    --focus-ring-offset: 2px;
    --textarea-h-s: 2.75rem;
    --textarea-h-m: 6rem;

    /* Opacity levels */
    --opacity-separator: 0.3;
    --opacity-disabled: 0.5;
    --opacity-subtle: 0.7;
    --opacity-normal: 0.85;
    --opacity-full: 1;

    /* Motion. One easing, two durations; only paint and compositing
       properties are transitioned: background-color, border-color, color,
       box-shadow, opacity, filter and transform. */
    --transition-ease: cubic-bezier(0.2, 0, 0, 1);
    --transition-fast: var(--wa-transition-fast, 120ms) var(--transition-ease);
    --transition-normal: var(--wa-transition-normal, 180ms)
      var(--transition-ease);

    /* Letter spacing. Caps for uppercase labels/badges, tight for display type
       (em scales with font-size). */
    --letter-spacing-caps: 0.06em;
    --letter-spacing-tight: -0.005em;
  }

  /* Match text selection to the host editor theme instead of the browser
     default. ::selection does not pierce shadow roots, so this ships with the
     token sheet every component adopts. */
  ::selection {
    background-color: var(--wa-color-editor-selection);
  }

  /* The desktop window has no title bar, so its header rows are drag
     regions, and Electron hands a real click over one to the window, not
     the page. The drag value is inherited, through shadow roots too, so a
     control or a dropdown's menu inside a header is dead to the mouse
     unless it says no-drag itself. A dialog opened from elsewhere can still
     overlap a header, so it opts out as well. Outside Electron the property
     is ignored. */
  button,
  input,
  textarea,
  select,
  a[href],
  wa-button,
  wa-input,
  wa-textarea,
  wa-select,
  wa-checkbox,
  wa-switch,
  wa-tag,
  wa-badge,
  wa-dropdown,
  wa-dialog::part(dialog),
  wa-drawer::part(dialog) {
    -webkit-app-region: no-drag;
  }

  /* Tooltip text must never inherit a selected row's accent foreground. */
  wa-tooltip,
  wa-tooltip::part(body) {
    color: var(--wa-tooltip-content-color);
    font-size: var(--wa-tooltip-font-size);
    font-weight: var(--font-weight-normal);
    line-height: var(--line-height-normal);
  }

  /* Honor the OS-level reduced-motion preference inside every shadow root
     that adopts the token sheet: collapse animations and transitions to a
     single imperceptible frame instead of removing end states. */
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;
