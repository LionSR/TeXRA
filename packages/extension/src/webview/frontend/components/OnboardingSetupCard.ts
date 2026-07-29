import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { ONBOARDING_SETUP_HANDOFF } from '@shared/copy/onboarding';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { MainViewEvents } from '../events';

/**
 * State 1 onboarding handoff: a credential exists, but the first setup run has
 * not completed yet. The setup agent is selected by the host; this card gives
 * users a direct, visible next action without hiding the normal launcher.
 */
@customElement('onboarding-setup-card')
export class OnboardingSetupCard extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      wa-callout {
        margin-bottom: var(--wa-space-s);
        padding: var(--wa-space-s) var(--wa-space-m);
      }

      .title {
        display: block;
        font-weight: var(--font-weight-semibold, 600);
        font-size: 1.05em;
        margin-bottom: var(--wa-space-2xs);
      }

      .copy {
        margin: 0 0 var(--wa-space-s);
        color: var(--vscode-descriptionForeground);
        line-height: var(--line-height-normal, 1.4);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
      }

      wa-button::part(base) {
        min-height: 28px;
      }
    `,
  ];

  private handleRunSetup(): void {
    this.dispatchEvent(MainViewEvents.onboardingRunSetup());
  }

  private handleOpenGettingStarted(): void {
    this.dispatchEvent(MainViewEvents.onboardingOpenGettingStarted());
  }

  private handleSkipSetup(): void {
    this.dispatchEvent(MainViewEvents.onboardingSkipSetup());
  }

  override render(): TemplateResult {
    return html`
      <wa-callout id="onboardingSetupCard" variant="brand">
        ${waIcon('rocket', { slot: 'icon' })}
        <span class="title">Credential ready</span>
        <p class="copy">${ONBOARDING_SETUP_HANDOFF}</p>
        <div class="actions">
          <wa-button
            id="onboardingRunSetupButton"
            variant="brand"
            appearance="filled"
            @click=${this.handleRunSetup}
          >
            ${waIcon('rocket')} Run setup assistant
          </wa-button>
          <wa-button
            id="onboardingOpenWalkthroughButton"
            appearance="outlined"
            @click=${this.handleOpenGettingStarted}
          >
            ${waIcon('book')} Open walkthrough
          </wa-button>
          <wa-button
            id="onboardingSkipSetupButton"
            appearance="plain"
            @click=${this.handleSkipSetup}
          >
            Skip setup
          </wa-button>
        </div>
      </wa-callout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'onboarding-setup-card': OnboardingSetupCard;
  }
}
