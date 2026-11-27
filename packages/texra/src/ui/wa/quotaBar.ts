// A subscription window's quota as a bar: how much is used, painted in the
// window's tone once it nears its limit. The surface adopts `toneStyles`
// and sizes the bar's width.

import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js';

import { subscriptionQuotaTone } from '@ui/copy/subscriptionUsage';

export const quotaBarStyles: CSSResult = css`
  .quota-bar {
    --track-height: 0.3rem;
    --indicator-color: var(--color-text-secondary);
  }

  .quota-bar:is(.tone-warning, .tone-danger) {
    --indicator-color: var(--tone-color);
  }
`;

/** The bar for a window `percentUsed` full. `label` names it for a screen
 *  reader; without one the bar is decoration beside text that says the
 *  same. */
export function renderQuotaBar(
  window: { readonly percentUsed: number },
  label?: string,
): TemplateResult {
  const tone = subscriptionQuotaTone(window);
  return html`<wa-progress-bar
    class="quota-bar ${tone === undefined ? '' : `tone-${tone}`}"
    value=${window.percentUsed}
    label=${ifDefined(label)}
    aria-hidden=${label === undefined ? 'true' : nothing}
  ></wa-progress-bar>`;
}
