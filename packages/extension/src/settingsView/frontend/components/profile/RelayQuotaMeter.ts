/** Compact monthly-spend meter for the Settings → Models tab. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/progress-bar/progress-bar.js';

import { designTokens } from '@shared/styles';
import {
  isSpendingQuotaExceeded,
  type SpendingStatus,
} from '@shared/schemas/spendingStatus';
import { clamp } from '@utils/core';
import { formatPercent } from '@utils/text/stringUtils';

const WARNING_THRESHOLD_PCT = 80;

type QuotaState = 'ok' | 'warning' | 'exhausted';

function quotaState(status: SpendingStatus): QuotaState {
  if (isSpendingQuotaExceeded(status)) return 'exhausted';
  if (status.percentUsed >= WARNING_THRESHOLD_PCT) return 'warning';
  return 'ok';
}

function quotaNote(
  state: QuotaState,
  autoSwitched: boolean,
  remainingPercent: number,
): string | null {
  if (state === 'exhausted') {
    return autoSwitched
      ? 'Monthly relay quota reached — the fallback is now Personal API keys. Included TeXRA access becomes available again with renewed quota.'
      : 'Monthly relay quota reached. Switch to your own API keys to keep going.';
  }
  if (state === 'warning') {
    return `${remainingPercent}% of your monthly relay quota left.`;
  }
  return null;
}

@customElement('relay-quota-meter')
export class RelayQuotaMeter extends LitElement {
  static override styles = [
    designTokens,
    css`
      :host {
        display: block;
      }
      .quota-meter {
        margin: 0 0 var(--wa-space-m);
        padding: var(--wa-space-m) var(--wa-space-l);
        border: var(--border-thin) solid var(--wa-color-neutral-border-quiet);
        border-radius: var(--border-radius);
        background: var(--wa-color-neutral-fill-quiet);
      }
      .quota-meter[data-state='exhausted'] {
        border-color: var(--wa-color-danger-border-quiet);
        background: var(--wa-color-danger-fill-quiet);
      }
      .quota-meter[data-state='warning'] {
        border-color: var(--wa-color-warning-border-quiet);
        background: var(--wa-color-warning-fill-quiet);
      }
      .quota-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--wa-space-m);
        margin-bottom: var(--wa-space-xs);
      }
      .quota-label {
        font-weight: var(--font-weight-semibold);
        font-size: var(--wa-font-size-s);
      }
      .quota-amount {
        font-variant-numeric: tabular-nums;
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-neutral-on-quiet);
      }
      /* Native wa-progress-bar, compacted to a 6px track; colour the indicator
         per quota state via its --indicator-color custom property. */
      .quota-bar {
        --track-height: 6px;
        --track-color: var(--wa-color-neutral-border-quiet);
        --indicator-color: var(--wa-color-brand-fill-loud);
      }
      .quota-meter[data-state='warning'] .quota-bar {
        --indicator-color: var(--wa-color-warning-fill-loud);
      }
      .quota-meter[data-state='exhausted'] .quota-bar {
        --indicator-color: var(--wa-color-danger-fill-loud);
      }
      .quota-note {
        margin-top: var(--wa-space-xs);
        font-size: var(--wa-font-size-xs);
        color: var(--wa-color-neutral-on-quiet);
      }
    `,
  ];

  /** When null, the meter renders nothing — caller should also gate. */
  @property({ attribute: false }) status: SpendingStatus | null = null;

  /**
   * True when the included-access toggle was auto-flipped off because
   * the quota was exhausted. Drives the explanatory copy near the meter.
   */
  @property({ type: Boolean }) autoSwitched = false;

  override render(): TemplateResult | typeof nothing {
    const s = this.status;
    if (!s) return nothing;

    const percent = clamp(s.percentUsed, 0, 100);
    const remainingPercent = Math.max(0, Math.round(100 - percent));
    const state = quotaState(s);
    const note = quotaNote(state, this.autoSwitched, remainingPercent);

    return html`
      <div class="quota-meter" data-state=${state}>
        <div class="quota-row">
          <span class="quota-label">Relay usage this month</span>
          <span class="quota-amount">${formatPercent(percent)} used</span>
        </div>
        <wa-progress-bar
          class="quota-bar"
          value=${Math.round(percent)}
          label="Relay usage this month"
        ></wa-progress-bar>
        ${note ? html`<div class="quota-note">${note}</div>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'relay-quota-meter': RelayQuotaMeter;
  }
}
