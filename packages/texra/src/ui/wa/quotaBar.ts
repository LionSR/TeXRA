// How full something is, as a bar: a subscription window's quota or a run's
// context window, painted in its tone once it nears its limit. The surface
// adopts `toneStyles` and sizes the bar's width.

import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js';

import type { RunTone } from '@ui/copy/runStatus';
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

/** The bar for something `percentUsed` full, in the `tone` its owner reads
 *  from that percentage; only a warning or danger tone colours it. `label`
 *  names it for a screen reader; without one the bar is decoration beside
 *  text that says the same. */
export function renderMeterBar(
  percentUsed: number,
  tone: RunTone | undefined,
  label?: string,
): TemplateResult {
  return html`<wa-progress-bar
    class="quota-bar ${tone === undefined ? '' : `tone-${tone}`}"
    value=${percentUsed}
    label=${ifDefined(label)}
    aria-hidden=${label === undefined ? 'true' : nothing}
  ></wa-progress-bar>`;
}

/** {@link renderMeterBar} for a subscription window, in the tone its quota
 *  has reached. */
export function renderQuotaBar(
  window: { readonly percentUsed: number },
  label?: string,
): TemplateResult {
  return renderMeterBar(
    window.percentUsed,
    subscriptionQuotaTone(window),
    label,
  );
}
