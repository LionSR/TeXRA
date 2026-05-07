// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import { TEXRA_ICON_LIBRARY } from './webAwesomeIcons';

export interface IconActionButtonOptions {
  readonly icon: string;
  readonly label: string;
  readonly title?: string;
  readonly action?: string;
  readonly className?: string;
  readonly onClick?: (event: MouseEvent) => void;
}

export function renderIconActionButton({
  icon,
  label,
  title,
  action,
  className,
  onClick,
}: IconActionButtonOptions): TemplateResult {
  const classes = ['action-icon-button', className].filter(Boolean).join(' ');

  return html`
    <wa-button
      class=${classes}
      appearance="outlined"
      variant="neutral"
      size="small"
      type="button"
      aria-label=${label}
      title=${title ?? label}
      data-action=${ifDefined(action)}
      @click=${onClick}
    >
      <wa-icon
        library=${TEXRA_ICON_LIBRARY}
        name=${icon}
        variant="solid"
      ></wa-icon>
    </wa-button>
  `;
}
