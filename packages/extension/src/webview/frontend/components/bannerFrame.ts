// Side-effect imports: register the WA elements the frame renders.
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

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
  readonly variant: 'warning' | 'brand';
  readonly icon?: TeXRAIconName;
  readonly calloutClassName?: string;
  readonly body: TemplateResult;
}): TemplateResult {
  return html`
    <div class="banner-frame">
      <wa-callout
        id=${options.id}
        class=${ifDefined(options.calloutClassName)}
        variant=${options.variant}
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
 * banners.
 */
export function renderWarningBanner(options: {
  readonly id: string;
  readonly body: TemplateResult;
}): TemplateResult {
  return renderBannerFrame({
    id: options.id,
    variant: 'warning',
    icon: 'triangle-exclamation',
    body: html`<div class="banner-row">${options.body}</div>`,
  });
}
