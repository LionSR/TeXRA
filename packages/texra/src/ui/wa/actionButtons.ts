// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import type { IconName } from '@ui/wa/iconNames';
import { waSpinner } from './spinner';
import { waIcon } from './webAwesomeIcons';

type ActionButtonKind =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'link'
  | 'danger'
  | 'segment';
/**
 * Step on the shared `--control-size` scale (24 / 28 / 32px). Use this instead
 * of a local `width`/`height` override: the skin derives the icon size and
 * radius from the same token, so a hand-written geometry desynchronizes them.
 */
type ActionButtonSize = 's' | 'm' | 'l';

const SIZE_CLASS = {
  s: 'is-size-s',
  m: 'is-size-m',
  l: 'is-size-l',
} as const satisfies Record<ActionButtonSize, string>;

interface ActionButtonSkin {
  readonly className?: string;
  readonly appearance: 'accent' | 'filled' | 'outlined' | 'plain';
  readonly variant: 'brand' | 'neutral';
}

/**
 * What a kind paints: the skin class `controlStyles.ts` styles, and the Web
 * Awesome appearance under it, so the two never disagree at a call site.
 */
const KIND_SKIN = {
  primary: { className: 'btn-primary', appearance: 'filled', variant: 'brand' },
  secondary: {
    className: 'btn-secondary',
    appearance: 'outlined',
    variant: 'neutral',
  },
  ghost: { className: 'btn-ghost', appearance: 'plain', variant: 'neutral' },
  link: {
    className: 'btn-ghost is-link',
    appearance: 'plain',
    variant: 'neutral',
  },
  danger: {
    className: 'btn-ghost is-danger',
    appearance: 'plain',
    variant: 'neutral',
  },
  // One segment of a `<wa-button-group>`: the base skin, with Web Awesome's
  // outlined appearance so the group overlaps neighbouring borders instead
  // of indenting each segment.
  segment: { appearance: 'outlined', variant: 'neutral' },
} as const satisfies Record<ActionButtonKind, ActionButtonSkin>;

/** No kind: the base `.action-button` / `.action-icon-button` skin. */
const PLAIN_SKIN: ActionButtonSkin = {
  appearance: 'plain',
  variant: 'neutral',
};

/**
 * The main half of a split button: Web Awesome's own accent chrome, matching
 * the trigger `splitButton.ts` renders beside it, with no skin class.
 */
const SPLIT_MAIN_SKIN: ActionButtonSkin = {
  appearance: 'accent',
  variant: 'brand',
};

/**
 * A hover hint is a `<wa-tooltip>`, which anchors to its button by `for`, so
 * it needs the button's `id`. A button with no `id` names a native `title`
 * instead.
 */
type ActionButtonTooltip =
  | { readonly id: string; readonly tooltip?: string }
  | { readonly id?: undefined; readonly tooltip?: undefined };

interface ActionButtonCommon {
  readonly title?: string;
  readonly action?: string;
  readonly className?: string;
  /**
   * Native `slot` attribute on the `<wa-button>` host. Needed when the
   * button itself (not a wrapper) must be the slotted light-DOM child of a
   * parent Web Awesome component (e.g. `<wa-input slot="end">`).
   */
  readonly slot?: string;
  /** Semantic skin; it decides the Web Awesome appearance too. */
  readonly kind?: ActionButtonKind;
  readonly disabled?: boolean;
  /** Selected state for toggle buttons. Reflected as `aria-pressed`. */
  readonly pressed?: boolean;
  readonly onClick?: (event: MouseEvent) => void;
}

/**
 * A disclosure toggle states whether its section is open (`expanded`,
 * reflected as `aria-expanded`) and the button draws the chevron, which
 * turns while open. It names no icon of its own, so no caller swaps or
 * rotates one by hand.
 */
interface DisclosureGlyph {
  readonly expanded: boolean;
  readonly icon?: undefined;
}

export type IconActionButtonOptions = ActionButtonCommon &
  ActionButtonTooltip &
  (
    | { readonly icon: IconName; readonly expanded?: undefined }
    | DisclosureGlyph
  ) & {
    readonly label: string;
    /** Icon-button geometry off the `--control-size` scale. Defaults to `s`. */
    readonly size?: ActionButtonSize;
    /**
     * When defined, the button renders inside an overlay wrapper: while
     * `true` a spinner covers the (hidden, disabled) button so the toolbar
     * layout does not shift. Styled by `busyIconButtonStyles` in
     * commonViewStyles. Icon-only: the centered icon-sized spinner only makes
     * sense over a square icon button.
     */
    readonly busy?: boolean;
  };

export type LabeledActionButtonOptions = ActionButtonCommon &
  ActionButtonTooltip &
  (
    | { readonly icon?: IconName; readonly expanded?: undefined }
    | DisclosureGlyph
  ) & {
    readonly text: string;
    readonly label?: string;
    /** The main half of a split button: the trigger's accent chrome. */
    readonly splitMain?: boolean;
    /** A trailing caret: the button opens a menu (a dropdown trigger). */
    readonly caret?: boolean;
  };

type ActionButtonBaseOptions = ActionButtonCommon &
  ActionButtonTooltip & {
    readonly icon?: IconName;
    readonly expanded?: boolean;
    readonly label?: string;
    readonly text?: string;
    readonly size?: ActionButtonSize;
    readonly busy?: boolean;
    readonly splitMain?: boolean;
    readonly caret?: boolean;
  };

/** The button and its (optional) sibling `<wa-tooltip>`, kept apart so a
 * `<wa-button-group>` caller can slot every button first and every tooltip
 * after — `<wa-button-group>` fuses corners via CSS `:first-child`/
 * `:last-child` on its slotted children, so an interleaved `<wa-tooltip>`
 * would break the segmenting. */
interface ActionButtonParts {
  readonly button: TemplateResult;
  readonly tooltip: TemplateResult | typeof nothing;
}

function renderActionButtonParts({
  id,
  icon,
  label,
  text,
  title,
  action,
  className,
  slot,
  kind,
  size,
  disabled,
  pressed,
  expanded,
  busy,
  tooltip,
  splitMain,
  caret,
  onClick,
}: ActionButtonBaseOptions): ActionButtonParts {
  let baseClass: string | undefined;
  if (!splitMain) baseClass = text ? 'action-button' : 'action-icon-button';
  let skin = PLAIN_SKIN;
  if (splitMain) skin = SPLIT_MAIN_SKIN;
  else if (kind) skin = KIND_SKIN[kind];
  const classes = [
    baseClass,
    skin.className,
    busy ? 'is-busy' : undefined,
    // Only meaningful on the square icon variant; a labeled button is sized by
    // its text and the shared button height.
    text || size === undefined ? undefined : SIZE_CLASS[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const ariaLabel = label ?? text ?? '';
  // wa-tooltip is position:absolute, so the sibling never affects flex flow.
  const tooltipTemplate =
    tooltip === undefined
      ? nothing
      : html`<wa-tooltip for=${id}>${tooltip}</wa-tooltip>`;
  // `aria-label` (below) already names the button, so a native `title` is
  // the hover hint only where no `wa-tooltip` shows one: both would double
  // it.
  const nativeTitle = title ?? (text ? undefined : ariaLabel);
  const glyph = (slot?: 'start'): TemplateResult | typeof nothing => {
    if (expanded !== undefined) {
      return waIcon('chevron-right', { className: 'disclosure-chevron', slot });
    }
    return icon ? waIcon(icon, { slot }) : nothing;
  };
  let content: TemplateResult | typeof nothing = nothing;
  if (text) {
    content = html`${glyph('start')}${text}`;
  } else if (icon || expanded !== undefined) {
    content = html`${glyph()}<span class="action-button-label"
        >${ariaLabel}</span
      >`;
  }

  const button = html`
    <wa-button
      id=${ifDefined(id)}
      slot=${ifDefined(slot)}
      class=${classes}
      appearance=${skin.appearance}
      variant=${skin.variant}
      size="s"
      type="button"
      aria-label=${ariaLabel}
      aria-pressed=${ifDefined(
        pressed === undefined ? undefined : String(pressed),
      )}
      aria-expanded=${ifDefined(
        expanded === undefined ? undefined : String(expanded),
      )}
      ?with-caret=${caret}
      title=${ifDefined(tooltip === undefined ? nativeTitle : undefined)}
      data-action=${ifDefined(action)}
      ?disabled=${disabled || busy}
      @click=${onClick}
      >${content}</wa-button
    >
  `;

  return { button, tooltip: tooltipTemplate };
}

function renderActionButtonBase(
  options: ActionButtonBaseOptions,
): TemplateResult {
  const { button, tooltip } = renderActionButtonParts(options);
  const { busy } = options;

  // `busy` undefined → plain button (unchanged for every other caller).
  // `busy` defined → stable overlay wrapper so toggling never reflows the row.
  if (busy === undefined) return html`${button}${tooltip}`;
  return html`
    <span class="action-icon-busy">
      ${button} ${busy ? waSpinner('action-busy-spinner') : nothing}
    </span>
    ${tooltip}
  `;
}

export function renderIconActionButton(
  options: IconActionButtonOptions,
): TemplateResult {
  return renderActionButtonBase(options);
}

export function renderLabeledActionButton(
  options: LabeledActionButtonOptions,
): TemplateResult {
  return renderActionButtonBase(options);
}

/**
 * Same button shapes as {@link renderIconActionButton} /
 * {@link renderLabeledActionButton}, but returns the button and its tooltip
 * as separate templates instead of concatenating them. Use inside a
 * `<wa-button-group>`: render every `.button` in the group's default slot,
 * then every `.tooltip` as a sibling after the group closes.
 */
export function renderIconActionButtonParts(
  options: IconActionButtonOptions,
): ActionButtonParts {
  return renderActionButtonParts(options);
}

/** Labeled counterpart to {@link renderIconActionButtonParts}. */
export function renderLabeledActionButtonParts(
  options: LabeledActionButtonOptions,
): ActionButtonParts {
  return renderActionButtonParts(options);
}
