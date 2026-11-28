import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/details/details.js';

import { joinFacts } from '@texra-ai/worldline/schemas';
import type { PlanUsage } from '@texra/shared/model/subscriptionUsage';
import {
  currentUsageWindows,
  formatSubscriptionUsageReset,
  formatSubscriptionUsageUpdated,
  planUsageName,
  subscriptionQuotaUsed,
  subscriptionUsageUnavailable,
  subscriptionUsageWindowLabel,
} from '@ui/copy/subscriptionUsage';
import { TexraElement } from '@ui/litBase';
import { toneStyles } from '@ui/styles/toneStyles';
import { quotaBarStyles, renderQuotaBar } from '@ui/wa/quotaBar';

@customElement('subscription-usage-row')
export class SubscriptionUsageRow extends TexraElement {
  static override styles = [
    TexraElement.styles,
    toneStyles,
    quotaBarStyles,
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
        gap: var(--wa-space-xs);
        padding: var(--wa-space-xs);
        background-color: var(--color-bg-secondary);
        border-radius: var(--border-radius);
      }

      .usage-window {
        display: grid;
        grid-template-columns: 6rem minmax(0, 1fr) 8rem;
        align-items: center;
        gap: var(--wa-space-xs);
        font-size: var(--font-size-sm);
      }

      wa-progress-bar {
        width: 100%;
      }

      .usage-window,
      .usage-updated {
        font-variant-numeric: tabular-nums;
      }

      .usage-plan {
        font-weight: var(--font-weight-medium);
      }

      .usage-reset {
        text-align: end;
      }

      .usage-updated,
      .usage-unavailable-detail {
        color: var(--color-text-secondary);
        font-size: var(--font-size-xs);
      }

      @container settings (max-width: 520px) {
        .usage-window {
          grid-template-columns: minmax(0, 1fr) auto;
        }

        .usage-summary {
          grid-column: 1;
          grid-row: 1;
        }

        .usage-window wa-progress-bar {
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

  @property({ attribute: false }) snapshot: PlanUsage | null = null;
  @property({ attribute: false }) now = 0;

  override render(): TemplateResult | typeof nothing {
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;
    // A plan with no credential has no usage to show; its key row says so.
    if (snapshot.unknown === 'missing_credentials') return nothing;
    if (snapshot.unknown !== undefined) {
      return html`
        <div class="settings-row subscription-usage-row">
          <div class="settings-row-text">
            <wa-details
              class="panel-collapsible"
              summary=${joinFacts(['Plan usage', 'unavailable'])}
            >
              <span class="usage-unavailable-detail">
                ${subscriptionUsageUnavailable(snapshot.unknown)}
              </span>
            </wa-details>
          </div>
        </div>
      `;
    }

    const planName = planUsageName(snapshot);
    return html`
      <div class="settings-row subscription-usage-row">
        <div class="settings-row-text">
          <div class="usage-card">
            <span class="usage-plan"
              ><bdi dir="auto">${planName}</bdi> usage</span
            >
            ${currentUsageWindows(snapshot, this.now).map((window) => {
              const label = subscriptionUsageWindowLabel(window);
              const percent = subscriptionQuotaUsed(window);
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
                  ${renderQuotaBar(window, `${planName} ${label} usage`)}
                  <span class="usage-reset"
                    ><bdi dir="auto">${reset ?? ''}</bdi></span
                  >
                </div>
              `;
            })}
            ${
              snapshot.at === undefined
                ? nothing
                : html`<span class="usage-updated">
                    ${formatSubscriptionUsageUpdated(snapshot.at, this.now)}
                  </span>`
            }
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
