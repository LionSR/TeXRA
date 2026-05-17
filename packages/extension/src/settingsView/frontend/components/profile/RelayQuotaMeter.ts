/** Compact monthly-spend meter for the Settings → Models tab. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens } from '@shared/styles';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';

import { profileViewStyles } from './styles';

const WARNING_THRESHOLD_PCT = 80;

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

type QuotaState = 'ok' | 'warning' | 'exhausted';

function quotaState(status: SpendingStatus): QuotaState {
  if (status.remaining <= 0) return 'exhausted';
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
      ? "Monthly relay quota reached — switched you to your own API keys. Toggle 'Use Included Access' back on to retry the relay."
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
    profileViewStyles,
    css`
      :host {
        display: block;
      }
      .quota-meter {
        margin: 0 0 var(--wa-space-m);
        padding: var(--wa-space-m) var(--wa-space-l);
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-neutral-background-quiet);
      }
      .quota-meter[data-state='exhausted'] {
        border-color: var(--wa-color-danger-border-quiet);
        background: var(--wa-color-danger-background-quiet);
      }
      .quota-meter[data-state='warning'] {
        border-color: var(--wa-color-warning-border-quiet);
        background: var(--wa-color-warning-background-quiet);
      }
      .quota-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--wa-space-m);
        margin-bottom: var(--wa-space-xs);
      }
      .quota-label {
        font-weight: 600;
        font-size: var(--wa-font-size-s);
      }
      .quota-amount {
        font-variant-numeric: tabular-nums;
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-neutral-text-quiet);
      }
      .quota-bar {
        position: relative;
        height: 6px;
        background: var(--wa-color-neutral-border-quiet);
        border-radius: 3px;
        overflow: hidden;
      }
      .quota-bar-fill {
        height: 100%;
        background: var(--wa-color-brand-fill-loud);
        transition: width 200ms ease-out;
      }
      .quota-meter[data-state='warning'] .quota-bar-fill {
        background: var(--wa-color-warning-fill-loud);
      }
      .quota-meter[data-state='exhausted'] .quota-bar-fill {
        background: var(--wa-color-danger-fill-loud);
      }
      .quota-note {
        margin-top: var(--wa-space-xs);
        font-size: var(--wa-font-size-xs);
        color: var(--wa-color-neutral-text-quiet);
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

    const percent = Math.min(100, Math.max(0, s.percentUsed));
    const remainingPercent = Math.max(0, Math.round(100 - percent));
    const state = quotaState(s);
    const note = quotaNote(state, this.autoSwitched, remainingPercent);

    return html`
      <div class="quota-meter" data-state=${state}>
        <div class="quota-row">
          <span class="quota-label">Relay usage this month</span>
          <span class="quota-amount"
            >${formatUsd(s.currentSpend)} / ${formatUsd(s.limit)}</span
          >
        </div>
        <div
          class="quota-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow=${Math.round(percent)}
        >
          <div class="quota-bar-fill" style="width: ${percent}%"></div>
        </div>
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
