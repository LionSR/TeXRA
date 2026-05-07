// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import { TEXRA_ICON_LIBRARY, type TeXRAIconName } from './webAwesomeIcons';

type ActionButtonAppearance = 'filled' | 'outlined' | 'plain';
type ActionButtonVariant = 'brand' | 'neutral';

export interface IconActionButtonOptions {
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title?: string;
  readonly action?: string;
  readonly className?: string;
  readonly appearance?: ActionButtonAppearance;
  readonly variant?: ActionButtonVariant;
  readonly onClick?: (event: MouseEvent) => void;
}

export interface LabeledActionButtonOptions extends IconActionButtonOptions {
  readonly text: string;
}

function renderActionButtonBase({
  icon,
  label,
  text,
  title,
  action,
  className,
  appearance = 'outlined',
  variant = 'neutral',
  onClick,
}: IconActionButtonOptions & { readonly text?: string }): TemplateResult {
  const classes = [text ? 'action-button' : 'action-icon-button', className]
    .filter(Boolean)
    .join(' ');
  const iconSlot = text ? 'start' : undefined;

  return html`
    <wa-button
      class=${classes}
      appearance=${appearance}
      variant=${variant}
      size="small"
      type="button"
      aria-label=${label}
      title=${title ?? label}
      data-action=${ifDefined(action)}
      @click=${onClick}
    >
      <wa-icon
        slot=${ifDefined(iconSlot)}
        library=${TEXRA_ICON_LIBRARY}
        name=${icon}
        variant="solid"
      ></wa-icon>
      ${text}
    </wa-button>
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
