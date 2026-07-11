// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import { type TeXRAIconName, waIcon } from './webAwesomeIcons';

type ActionButtonAppearance = 'filled' | 'outlined' | 'plain';
type ActionButtonVariant = 'brand' | 'neutral';

export interface IconActionButtonOptions {
  readonly id?: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title?: string;
  readonly action?: string;
  readonly className?: string;
  readonly appearance?: ActionButtonAppearance;
  readonly variant?: ActionButtonVariant;
  readonly disabled?: boolean;
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
  'label' | 'busy'
> {
  readonly text: string;
  readonly label?: string;
}

interface ActionButtonBaseOptions extends Omit<
  IconActionButtonOptions,
  'label'
> {
  readonly label?: string;
  readonly text?: string;
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
  disabled,
  busy,
  tooltip,
  hidden,
  ariaHidden,
  onClick,
}: ActionButtonBaseOptions): ActionButtonParts {
  const classes = [
    text ? 'action-button' : 'action-icon-button',
    busy ? 'is-busy' : undefined,
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
  const nativeTitle = tooltip && !id ? tooltip : (title ?? ariaLabel);

  const button = html`
    <wa-button
      id=${ifDefined(id)}
      class=${classes}
      appearance=${appearance}
      variant=${variant}
      size="small"
      type="button"
      aria-label=${ariaLabel}
      title=${ifDefined(useWebAwesomeTooltip ? undefined : nativeTitle)}
      data-action=${ifDefined(action)}
      ?disabled=${disabled || busy}
      ?hidden=${hidden}
      aria-hidden=${ifDefined(
        ariaHidden === undefined ? undefined : String(ariaHidden),
      )}
      @click=${onClick}
    >
      ${waIcon(icon, { slot: text ? 'start' : undefined })} ${text}
    </wa-button>
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

export function renderLabeledActionButtonParts(
  options: LabeledActionButtonOptions,
): ActionButtonParts {
  return renderActionButtonParts(options);
}
