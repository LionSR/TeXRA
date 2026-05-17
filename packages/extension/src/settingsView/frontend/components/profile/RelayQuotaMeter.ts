/** Compact monthly-spend meter for the Settings → Models tab. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens } from '@shared/styles';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';

import { profileViewStyles } from './styles';

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
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
        margin: 0 0 var(--wa-space-m, 12px);
        padding: var(--wa-space-m, 12px) var(--wa-space-l, 16px);
        border: 1px solid var(--wa-color-neutral-border-quiet, #ddd);
        border-radius: var(--wa-border-radius-m, 6px);
        background: var(--wa-color-neutral-background-quiet, #f7f7f7);
      }
      .quota-meter[data-state='exhausted'] {
        border-color: var(--wa-color-danger-border-quiet, #e8b4b4);
        background: var(--wa-color-danger-background-quiet, #fdecec);
      }
      .quota-meter[data-state='warning'] {
        border-color: var(--wa-color-warning-border-quiet, #e8d4a8);
        background: var(--wa-color-warning-background-quiet, #fdf6e3);
      }
      .quota-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--wa-space-m, 12px);
        margin-bottom: var(--wa-space-xs, 4px);
      }
      .quota-label {
        font-weight: 600;
        font-size: var(--wa-font-size-s, 0.875rem);
      }
      .quota-amount {
        font-variant-numeric: tabular-nums;
        font-size: var(--wa-font-size-s, 0.875rem);
        color: var(--wa-color-neutral-text-quiet, #555);
      }
      .quota-bar {
        position: relative;
        height: 6px;
        background: var(--wa-color-neutral-border-quiet, #e0e0e0);
        border-radius: 3px;
        overflow: hidden;
      }
      .quota-bar-fill {
        height: 100%;
        background: var(--wa-color-brand-fill-loud, #4080ff);
        transition: width 200ms ease-out;
      }
      .quota-meter[data-state='warning'] .quota-bar-fill {
        background: var(--wa-color-warning-fill-loud, #d49b1a);
      }
      .quota-meter[data-state='exhausted'] .quota-bar-fill {
        background: var(--wa-color-danger-fill-loud, #d44a4a);
      }
      .quota-note {
        margin-top: var(--wa-space-xs, 4px);
        font-size: var(--wa-font-size-xs, 0.75rem);
        color: var(--wa-color-neutral-text-quiet, #666);
      }
    `,
  ];

  /** When null, the meter renders nothing — caller should also gate. */
  @property({ attribute: false }) status: SpendingStatus | null = null;

  /**
   * True when the included-access toggle was auto-flipped off because
   * the quota was exhausted. Used to surface the cause near the meter
   * so users know why they were moved to BYOK.
   */
  @property({ type: Boolean }) autoSwitched = false;

  override render(): TemplateResult | typeof nothing {
    const s = this.status;
    if (!s) return nothing;

    const percent = Math.min(100, Math.max(0, s.percentUsed));
    const remainingPercent = Math.max(0, Math.round(100 - percent));
    const state =
      s.remaining <= 0 ? 'exhausted' : percent >= 80 ? 'warning' : 'ok';

    const note =
      state === 'exhausted'
        ? this.autoSwitched
          ? "Monthly relay quota reached — switched you to your own API keys. Toggle 'Use Included Access' back on to retry the relay."
          : 'Monthly relay quota reached. Switch to your own API keys to keep going.'
        : state === 'warning'
          ? `${remainingPercent}% of your monthly relay quota left.`
          : null;

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
