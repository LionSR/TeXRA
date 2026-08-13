// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - Web Awesome
import { renderBannerFrame } from './bannerFrame';
import { waIcon } from './webAwesomeIcons';
import type { TeXRAIconName } from './iconNames';

export interface SettingsBannerOptions {
  readonly id: string;
  readonly title: string;
  readonly description: string | TemplateResult;
  readonly icon?: TeXRAIconName;
  readonly detail?: TemplateResult | typeof nothing;
  readonly actions?: TemplateResult | typeof nothing;
  readonly className?: string;
  readonly variant?: 'brand' | 'neutral' | 'success' | 'warning' | 'danger';
}

/**
 * Shared informational banner for Settings tabs.
 *
 * Callers provide content only. Web Awesome owns the callout surface, while
 * settingsBannerStyles owns its hierarchy, spacing, icon, and action row.
 */
export function renderSettingsBanner(
  options: SettingsBannerOptions,
): TemplateResult {
  return renderBannerFrame({
    id: options.id,
    variant: options.variant ?? 'neutral',
    appearance: 'outlined',
    size: 's',
    frameClassName: ['settings-banner', options.className]
      .filter(Boolean)
      .join(' '),
    body: html`
      <div class="settings-banner-layout">
        <span class="settings-banner-icon icon-surface is-size-m">
          ${waIcon(options.icon ?? 'circle-info')}
        </span>
        <div class="settings-banner-body">
          <div class="settings-banner-title">${options.title}</div>
          <div class="settings-banner-description">${options.description}</div>
          ${
            options.detail == null || options.detail === nothing
              ? nothing
              : html`<div class="settings-banner-detail">
                  ${options.detail}
                </div>`
          }
        </div>
        ${
          options.actions == null || options.actions === nothing
            ? nothing
            : html`<div class="settings-banner-actions">
                ${options.actions}
              </div>`
        }
      </div>
    `,
  });
}
