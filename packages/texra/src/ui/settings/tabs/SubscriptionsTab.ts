/**
 * Subscription sign-in on the Models page: ChatGPT and Grok. Kimi Code and
 * GLM Coding Plan are API keys, so they live on their provider rows above,
 * with their usage meters.
 */

import { html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles, schemas, and templates
import { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/worldline/schemas';
import type { SubscriptionAuthStatuses } from '@texra/shared/model/subscriptionAuthStatus';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postToHost } from '@ui/settings/messageDispatcher';
import { TexraElement } from '@ui/litBase';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';

// Side-effect imports - register the WA button component
import '@awesome.me/webawesome/dist/components/button/button.js';

// Local imports - settings view components (importing the descriptors also
// registers the <subscription-section> element)
import { SUBSCRIPTION_SECTIONS } from '../components/profile/SubscriptionSection';

@customElement('subscriptions-tab')
export class SubscriptionsTab extends TexraElement {
  static override styles = [
    TexraElement.styles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */
    `,
  ];

  @property({ attribute: false }) subscriptionAuth: SubscriptionAuthStatuses =
    {};

  // The coding plans' usage meters on the provider rows above read this
  // request's snapshots.
  override connectedCallback(): void {
    super.connectedCallback();
    postToHost({
      command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
      forceRefresh: false,
    });
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
            onClick: () =>
              postToHost({
                command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
                forceRefresh: true,
              }),
          }),
        })}
        ${SUBSCRIPTION_AUTH_PROVIDERS.map(
          (provider) =>
            html`<subscription-section
              .provider=${SUBSCRIPTION_SECTIONS[provider]}
              .auth=${this.subscriptionAuth[provider] ?? null}
            ></subscription-section>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'subscriptions-tab': SubscriptionsTab;
  }
}
