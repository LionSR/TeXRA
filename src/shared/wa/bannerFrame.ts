// Side-effect imports: register the WA elements the frame renders.
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/**
 * Shared chrome for every inline banner (agent-config, api-key, dependency,
 * login, getting-started): the `.banner-frame` wrapper, a `wa-callout` in the
 * given variant with an optional icon in its `icon` slot, and caller-supplied
 * body content.
 *
 * Keeping the frame in one place makes it the single source of truth for what
 * a banner looks like. A change to the chrome (variant, icon slot, wrapper)
 * lands here instead of in five near-identical component templates.
 */
export function renderBannerFrame(options: {
  readonly id: string;
  readonly variant: 'brand' | 'neutral' | 'success' | 'warning' | 'danger';
  readonly appearance?: 'accent' | 'filled' | 'outlined' | 'plain';
  readonly size?: 's' | 'm' | 'l';
  readonly icon?: TeXRAIconName;
  readonly frameClassName?: string;
  readonly calloutClassName?: string;
  readonly role?: string;
  readonly ariaLabel?: string;
  readonly body: TemplateResult;
}): TemplateResult {
  return html`
    <div class=${`banner-frame ${options.frameClassName ?? ''}`.trim()}>
      <wa-callout
        id=${options.id}
        class=${ifDefined(options.calloutClassName)}
        variant=${options.variant}
        appearance=${ifDefined(options.appearance)}
        size=${ifDefined(options.size)}
        role=${ifDefined(options.role)}
        aria-label=${ifDefined(options.ariaLabel)}
      >
        ${options.icon ? waIcon(options.icon, { slot: 'icon' }) : nothing}
        ${options.body}
      </wa-callout>
    </div>
  `;
}

/**
 * Warning-variant banner with the shared triangle-exclamation icon and a
 * `.banner-row` body wrapper, used by the agent-config/api-key/dependency
 * banners. `role` forwards to the callout: the banners stay mounted and are
 * shown/hidden via CSS, so a live-region role is what makes a newly visible
 * banner announce.
 */
export function renderWarningBanner(options: {
  readonly id: string;
  readonly role?: 'alert' | 'status';
  readonly body: TemplateResult;
}): TemplateResult {
  return renderBannerFrame({
    id: options.id,
    variant: 'warning',
    icon: 'triangle-exclamation',
    role: options.role,
    body: html`<div class="banner-row">${options.body}</div>`,
  });
}
