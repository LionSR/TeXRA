import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
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

function unavailableDetail(
  reason: Extract<
    SubscriptionUsageSnapshot,
    { state: 'unavailable' }
  >['reason'],
): string {
  if (reason === 'invalid_credentials') {
    return 'The provider rejected the configured credentials.';
  }
  if (reason === 'malformed_response') {
    return 'The provider returned usage data TeXRA could not read.';
  }
  return 'The provider usage request failed. Try refreshing again shortly.';
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

      .usage-facts {
        display: grid;
        gap: 0.4rem;
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
        accent-color: var(--vscode-progressBar-background);
      }

      .usage-window,
      .usage-updated {
        font-variant-numeric: tabular-nums;
      }

      .usage-updated,
      .usage-unavailable-detail {
        color: var(--vscode-descriptionForeground);
        font-size: var(--wa-font-size-xs, 0.75rem);
      }
    `,
  ];

  @property({ attribute: false }) snapshot: SubscriptionUsageSnapshot | null =
    null;
  @property({ attribute: false }) now = Date.now();

  private clock: ReturnType<typeof setInterval> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.refreshNow();
    this.clock = setInterval(() => this.refreshNow(), 60_000);
  }

  override disconnectedCallback(): void {
    if (this.clock !== undefined) clearInterval(this.clock);
    this.clock = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('snapshot')) this.refreshNow();
  }

  private refreshNow(): void {
    this.now = Date.now();
  }

  override render(): TemplateResult | typeof nothing {
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;
    if (snapshot.state === 'unavailable') {
      if (
        snapshot.reason === 'missing_credentials' ||
        snapshot.reason === 'unsupported'
      ) {
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

    const summary = snapshot.windows
      .map(
        (window) =>
          `${subscriptionUsageWindowLabel(window)}: ${formatSubscriptionUsagePercent(window.percentUsed)}`,
      )
      .join(' · ');
    return html`
      <div class="settings-row subscription-usage-row">
        <div class="settings-row-text">
          <wa-details
            class="panel-collapsible"
            summary="${snapshot.planName} usage · ${summary}"
          >
            <div class="usage-facts">
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
                    <span>${label}: ${percent}</span>
                    <progress
                      max="100"
                      value=${window.percentUsed}
                      aria-label="${snapshot.providerName} ${label} usage: ${percent} used"
                    ></progress>
                    <span>${reset ?? ''}</span>
                  </div>
                `;
              })}
              <span class="usage-updated">
                ${formatSubscriptionUsageUpdated(snapshot.fetchedAt, this.now)}
              </span>
            </div>
          </wa-details>
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
