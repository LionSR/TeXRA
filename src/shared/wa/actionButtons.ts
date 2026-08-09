// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import { waIcon } from './webAwesomeIcons';
import type { TeXRAIconName } from './iconNames';

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

export interface IconActionButtonOptions {
  readonly id?: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title?: string;
  readonly action?: string;
  readonly className?: string;
  readonly appearance?: ActionButtonAppearance;
  readonly variant?: ActionButtonVariant;
  /** Semantic skin. Prefer this over choosing appearance/variant directly. */
  readonly kind?: ActionButtonKind;
  /** Icon-button geometry off the `--control-size` scale. Defaults to `s`. */
  readonly size?: ActionButtonSize;
  readonly disabled?: boolean;
  /** Selected state for toggle buttons. Reflected as `aria-pressed`. */
  readonly pressed?: boolean;
  /**
   * Icon-only. When defined, the button renders inside an overlay wrapper:
   * while `true` a spinner covers the (hidden, disabled) button so the toolbar
   * layout does not shift. Styled by `busyIconButtonStyles` in commonViewStyles.
   * Omitted from the labeled variant — the centered icon-sized spinner only
   * makes sense over a square icon button.
   */
  readonly busy?: boolean;
  /**
   * Native Web Awesome tooltip text. When `id` is present, the `<wa-tooltip>`
   * anchors via `for` within the same shadow root. Without an anchor, this
   * falls back to the native `title` attribute so the hint is still visible.
   */
  readonly tooltip?: string;
  /** Reflects `hidden` on the button host — removes it from layout/a11y
   * tree while keeping the same DOM node (e.g. a chrome action that only
   * applies in some view states). */
  readonly hidden?: boolean;
  /** Explicit `aria-hidden="true"|"false"` on the button host, independent
   * of `hidden` — for toolbars that keep an inert button in the layout
   * (e.g. CSS-faded) but still want it out of the accessibility tree. */
  readonly ariaHidden?: boolean;
  readonly onClick?: (event: MouseEvent) => void;
}

export interface LabeledActionButtonOptions extends Omit<
  IconActionButtonOptions,
  'label' | 'busy' | 'icon' | 'size'
> {
  readonly icon?: TeXRAIconName;
  readonly text: string;
  readonly label?: string;
  /** Let a containing Web Awesome primitive own the button's native chrome. */
  readonly nativeChrome?: boolean;
}

interface ActionButtonBaseOptions extends Omit<
  IconActionButtonOptions,
  'icon' | 'label'
> {
  readonly icon?: TeXRAIconName;
  readonly label?: string;
  readonly text?: string;
  readonly nativeChrome?: boolean;
}

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
  appearance = 'plain',
  variant = 'neutral',
  kind,
  size,
  disabled,
  pressed,
  busy,
  tooltip,
  hidden,
  ariaHidden,
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
  const useWebAwesomeTooltip = Boolean(tooltip && id);
  // wa-tooltip is position:absolute, so the sibling never affects flex flow.
  const tooltipTemplate = useWebAwesomeTooltip
    ? html`<wa-tooltip for=${id}>${tooltip}</wa-tooltip>`
    : nothing;
  // `aria-label` (below) already names the button unconditionally, so `title`
  // is only needed as a fallback hint when there's no `wa-tooltip` sibling to
  // show one — setting both here would double up the hover hint (native
  // tooltip + wa-tooltip) for every id+tooltip icon button.
  const nativeTitle = tooltip && !id ? tooltip : (title ?? ariaLabel);
  let content: TemplateResult | typeof nothing = nothing;
  if (text) {
    content = html`${icon ? waIcon(icon, { slot: 'start' }) : nothing}${text}`;
  } else if (icon) {
    content = waIcon(icon);
  }

  const button = html`
    <wa-button
      id=${ifDefined(id)}
      class=${classes}
      appearance=${appearance}
      variant=${variant}
      size="s"
      type="button"
      aria-label=${ariaLabel}
      aria-pressed=${ifDefined(
        pressed === undefined ? undefined : String(pressed),
      )}
      title=${ifDefined(useWebAwesomeTooltip ? undefined : nativeTitle)}
      data-action=${ifDefined(action)}
      ?disabled=${disabled || busy}
      ?hidden=${hidden}
      aria-hidden=${ifDefined(
        ariaHidden === undefined ? undefined : String(ariaHidden),
      )}
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
