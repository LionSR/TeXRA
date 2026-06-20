// Side-effect imports — register the WA elements the frame renders.
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, type TemplateResult } from 'lit';

import { waIcon } from '@shared/wa/webAwesomeIcons';

/**
 * Shared chrome for the inline warning banners (agent-config, api-key,
 * dependency): the `.banner-frame` wrapper, a `warning` `wa-callout`, the
 * triangle-exclamation icon, and the `.banner-row` body container. Layout and
 * spacing live in `bannerStyles`.
 *
 * Keeping the frame in one place makes it the single source of truth for what a
 * warning banner looks like — a change to the chrome (icon, variant, row
 * structure) lands here instead of in three near-identical component templates.
 */
export function renderWarningBanner(options: {
  readonly id: string;
  readonly body: TemplateResult;
}): TemplateResult {
  return html`
    <div class="banner-frame">
      <wa-callout id=${options.id} variant="warning">
        ${waIcon('triangle-exclamation', { slot: 'icon' })}
        <div class="banner-row">${options.body}</div>
      </wa-callout>
    </div>
  `;
}
