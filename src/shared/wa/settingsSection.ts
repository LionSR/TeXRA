// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - Web Awesome
import type { TeXRAIconName } from './iconNames';
import { waIcon } from './webAwesomeIcons';

export interface SettingsSectionHeadingOptions {
  readonly title: string;
  readonly description?: string | TemplateResult;
  readonly icon?: TeXRAIconName;
  readonly actions?: TemplateResult | typeof nothing;
  readonly id?: string;
}

/** Renders the one heading hierarchy shared by every Settings page section. */
export function renderSettingsSectionHeading(
  options: SettingsSectionHeadingOptions,
): TemplateResult {
  return html`
    <header class="settings-section-heading">
      <div class="settings-section-heading-row">
        ${
          options.icon
            ? waIcon(options.icon, {
                className: 'settings-section-heading-icon',
              })
            : nothing
        }
        <h2 id=${options.id ?? nothing} class="settings-section-heading-title">
          ${options.title}
        </h2>
        ${
          options.actions
            ? html`<div class="settings-section-heading-actions">
                ${options.actions}
              </div>`
            : nothing
        }
      </div>
      ${
        options.description
          ? html`<p class="settings-section-heading-description">
              ${options.description}
            </p>`
          : nothing
      }
    </header>
  `;
}
