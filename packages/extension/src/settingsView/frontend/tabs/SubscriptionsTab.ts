/**
 * Subscription sign-in on the Models page: ChatGPT and Grok. Kimi Code and GLM Coding Plan are API keys, so they live on their
 * provider rows above, with their usage meters.
 */

import {
  LitElement,
  html,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles, schemas, and templates
import type { SubscriptionAuthStatuses } from '@texra/shared/model/subscriptionAuth';
import type { SubscriptionUsageSnapshots } from '@texra/shared/model/subscriptionUsage';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import { TickerController } from '@texra/shared/litControllers/TickerController';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';

// Side-effect imports - register the WA button component
import '@awesome.me/webawesome/dist/components/button/button.js';

// Local imports - settings view components (importing the descriptors also
// registers the <subscription-section> element)
import {
  CHATGPT_SUBSCRIPTION_SECTION,
  GROK_SUBSCRIPTION_SECTION,
} from '../components/profile/SubscriptionSection';
import '../components/profile/SubscriptionUsageRow';

@customElement('subscriptions-tab')
export class SubscriptionsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */
    `,
  ];

  /** Parent-owned acknowledgement generation for restoring rejected edits. */
  @property({ attribute: false }) ackGeneration = 0;
  @property({ attribute: false }) subscriptionAuth: SubscriptionAuthStatuses =
    {};
  @property({ attribute: false }) chatgptCodexContextWindow: number | null =
    null;
  @property({ attribute: false }) usage: SubscriptionUsageSnapshots | null =
    null;

  private readonly _ticker = new TickerController(this, 60_000);

  override connectedCallback(): void {
    super.connectedCallback();
    postMessage(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE, {
      forceRefresh: false,
    });
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('usage')) this._ticker.refresh();
  }

  override render(): TemplateResult {
    return html`
      <div class="subscriptions-container">
        ${renderSettingsSectionHeading({
          title: 'Subscriptions',
          description:
            'Use a ChatGPT or Grok plan instead of an API key. Usage refreshes when this page opens.',
          icon: 'gem',
          actions: renderLabeledActionButton({
            icon: 'arrows-rotate',
            text: 'Refresh usage',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () =>
              postMessage(SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE, {
                forceRefresh: true,
              }),
          }),
        })}
        <subscription-section
          .ackGeneration=${this.ackGeneration}
          .provider=${CHATGPT_SUBSCRIPTION_SECTION}
          .auth=${this.subscriptionAuth.chatgpt ?? null}
          .contextWindow=${this.chatgptCodexContextWindow}
          .usage=${this.usage?.chatgpt ?? null}
          .now=${this._ticker.now}
        ></subscription-section>
        <subscription-section
          .provider=${GROK_SUBSCRIPTION_SECTION}
          .auth=${this.subscriptionAuth.grok ?? null}
          .now=${this._ticker.now}
        ></subscription-section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'subscriptions-tab': SubscriptionsTab;
  }
}
