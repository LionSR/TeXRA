// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, type TemplateResult } from 'lit';
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
  readonly onClick?: (event: MouseEvent) => void;
}

export interface LabeledActionButtonOptions
  extends Omit<IconActionButtonOptions, 'label'> {
  readonly text: string;
  readonly label?: string;
}

interface ActionButtonBaseOptions
  extends Omit<IconActionButtonOptions, 'label'> {
  readonly label?: string;
  readonly text?: string;
}

function renderActionButtonBase({
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
  onClick,
}: ActionButtonBaseOptions): TemplateResult {
  const classes = [text ? 'action-button' : 'action-icon-button', className]
    .filter(Boolean)
    .join(' ');
  const ariaLabel = label ?? text ?? '';

  return html`
    <wa-button
      id=${ifDefined(id)}
      class=${classes}
      appearance=${appearance}
      variant=${variant}
      size="small"
      type="button"
      aria-label=${ariaLabel}
      title=${title ?? ariaLabel}
      data-action=${ifDefined(action)}
      ?disabled=${disabled}
      @click=${onClick}
    >
      ${waIcon(icon, { slot: text ? 'start' : undefined })} ${text}
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
