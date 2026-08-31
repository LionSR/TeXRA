import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/details/details.js';

import { commonViewStyles, designTokens } from '@shared/styles';
import {
  formatSubscriptionUsagePercent,
  formatSubscriptionUsageReset,
  formatSubscriptionUsageUpdated,
  subscriptionUsageWindowLabel,
} from '@shared/subscriptionUsagePresentation';
import type { SubscriptionUsageSnapshot } from '@shared/schemas';

type UnavailableReason = Extract<
  SubscriptionUsageSnapshot,
  { state: 'unavailable' }
>['reason'];

const UNAVAILABLE_DETAILS: Record<UnavailableReason, string | undefined> = {
  invalid_credentials: 'The provider rejected the configured credentials.',
  malformed_response: 'The provider returned usage data TeXRA could not read.',
  missing_credentials: undefined,
  request_failed: undefined,
};

function unavailableDetail(reason: UnavailableReason): string {
  return (
    UNAVAILABLE_DETAILS[reason] ??
    'The provider usage request failed. Try refreshing again shortly.'
  );
}

@customElement('subscription-usage-row')
export class SubscriptionUsageRow extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: contents;
      }

      .subscription-usage-row,
      .subscription-usage-row .settings-row-text {
        flex: 1 1 100%;
        width: 100%;
        min-width: 0;
      }

      wa-details {
        display: block;
        width: 100%;
        min-width: 0;
      }

      .usage-card {
        display: grid;
        gap: 0.4rem;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        background-color: var(--wa-color-surface-lowered, transparent);
        border-radius: var(--wa-border-radius-m, 0.5rem);
      }

      .usage-window {
        display: grid;
        grid-template-columns: minmax(5rem, auto) minmax(5rem, 1fr) auto;
        align-items: center;
        gap: 0.55rem;
        font-size: var(--wa-font-size-s, 0.8125rem);
      }

      progress {
        width: 100%;
        height: 0.45rem;
        accent-color: var(--wa-color-progress-bg);
      }

      .usage-window,
      .usage-updated {
        font-variant-numeric: tabular-nums;
      }

      .usage-plan {
        font-weight: 600;
      }

      .usage-updated,
      .usage-unavailable-detail {
        color: var(--color-text-secondary);
        font-size: var(--wa-font-size-xs, 0.75rem);
      }

      @container settings (max-width: 520px) {
        .usage-window {
          grid-template-columns: minmax(0, 1fr) auto;
        }

        .usage-summary {
          grid-column: 1;
          grid-row: 1;
        }

        .usage-window progress {
          grid-column: 1 / -1;
          grid-row: 2;
        }

        .usage-reset {
          grid-column: 2;
          grid-row: 1;
        }
      }
    `,
  ];

  @property({ attribute: false }) snapshot: SubscriptionUsageSnapshot | null =
    null;
  @property({ attribute: false }) now = 0;

  override render(): TemplateResult | typeof nothing {
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;
    if (snapshot.state === 'unavailable') {
      if (snapshot.reason === 'missing_credentials') {
        return nothing;
      }
      return html`
        <div class="settings-row subscription-usage-row">
          <div class="settings-row-text">
            <wa-details
              class="panel-collapsible"
              summary="Plan usage · unavailable"
            >
              <span class="usage-unavailable-detail">
                ${unavailableDetail(snapshot.reason)}
              </span>
            </wa-details>
          </div>
        </div>
      `;
    }

    return html`
      <div class="settings-row subscription-usage-row">
        <div class="settings-row-text">
          <div class="usage-card">
            <span class="usage-plan"
              ><bdi dir="auto">${snapshot.planName}</bdi> usage</span
            >
            ${snapshot.windows.map((window) => {
              const label = subscriptionUsageWindowLabel(window);
              const percent = formatSubscriptionUsagePercent(
                window.percentUsed,
              );
              const reset = formatSubscriptionUsageReset(
                window.resetAt,
                this.now,
              );
              return html`
                <div class="usage-window">
                  <span class="usage-summary"
                    ><bdi dir="auto">${label}</bdi>:
                    <bdi dir="auto">${percent}</bdi></span
                  >
                  <progress
                    max="100"
                    value=${window.percentUsed}
                    aria-label="${snapshot.providerName} ${label} usage"
                  ></progress>
                  <span class="usage-reset"
                    ><bdi dir="auto">${reset ?? ''}</bdi></span
                  >
                </div>
              `;
            })}
            <span class="usage-updated">
              ${formatSubscriptionUsageUpdated(snapshot.fetchedAt, this.now)}
            </span>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'subscription-usage-row': SubscriptionUsageRow;
  }
}
