// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import type { IconName } from '@ui/wa/iconNames';
import { stopSpinnerMotion } from './spinner';
import { waIcon } from './webAwesomeIcons';

type ActionButtonAppearance = 'accent' | 'filled' | 'outlined' | 'plain';
type ActionButtonVariant = 'brand' | 'neutral';
type ActionButtonKind = 'primary' | 'secondary' | 'ghost' | 'link' | 'danger';
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

const KIND_CLASS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  link: 'btn-ghost is-link',
  danger: 'btn-ghost is-danger',
} as const satisfies Record<ActionButtonKind, string>;

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
  readonly appearance?: ActionButtonAppearance;
  readonly variant?: ActionButtonVariant;
  /** Semantic skin. Prefer this over choosing appearance/variant directly. */
  readonly kind?: ActionButtonKind;
  readonly disabled?: boolean;
  /** Selected state for toggle buttons. Reflected as `aria-pressed`. */
  readonly pressed?: boolean;
  readonly onClick?: (event: MouseEvent) => void;
}

export type IconActionButtonOptions = ActionButtonCommon &
  ActionButtonTooltip & {
    readonly icon: IconName;
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
  ActionButtonTooltip & {
    readonly icon?: IconName;
    readonly text: string;
    readonly label?: string;
    /** Let a containing Web Awesome primitive own the button's native chrome. */
    readonly nativeChrome?: boolean;
  };

type ActionButtonBaseOptions = ActionButtonCommon &
  ActionButtonTooltip & {
    readonly icon?: IconName;
    readonly label?: string;
    readonly text?: string;
    readonly size?: ActionButtonSize;
    readonly busy?: boolean;
    readonly nativeChrome?: boolean;
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
  appearance = 'plain',
  variant = 'neutral',
  kind,
  size,
  disabled,
  pressed,
  busy,
  tooltip,
  nativeChrome,
  onClick,
}: ActionButtonBaseOptions): ActionButtonParts {
  let baseClass: string | undefined;
  if (!nativeChrome) baseClass = text ? 'action-button' : 'action-icon-button';
  const classes = [
    baseClass,
    kind ? KIND_CLASS[kind] : undefined,
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
  let content: TemplateResult | typeof nothing = nothing;
  if (text) {
    content = html`${icon ? waIcon(icon, { slot: 'start' }) : nothing}${text}`;
  } else if (icon) {
    content = html`${waIcon(icon)}<span class="action-button-label"
        >${ariaLabel}</span
      >`;
  }

  const button = html`
    <wa-button
      id=${ifDefined(id)}
      slot=${ifDefined(slot)}
      class=${classes}
      appearance=${appearance}
      variant=${variant}
      size="s"
      type="button"
      aria-label=${ariaLabel}
      aria-pressed=${ifDefined(
        pressed === undefined ? undefined : String(pressed),
      )}
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
      ${button}
      ${
        busy
          ? html`<wa-spinner
              class="action-busy-spinner"
              aria-hidden="true"
              ${stopSpinnerMotion()}
            ></wa-spinner>`
          : nothing
      }
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
