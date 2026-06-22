import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  ONBOARDING_CARD_TITLE,
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_CHOICE_SIGN_IN,
  ONBOARDING_CHOICE_SKIP_LABEL,
} from '@shared/copy/onboarding';

import { MainViewEvents } from '../events';

/**
 * State 0 welcome card (PRD: agent-native onboarding) — a port of the CLI
 * first-run picker, not a new design: sign-in recommended first, provider
 * ChatGPT/API key alternatives, and a quiet "Skip for now" link last.
 * Stateless: renders the
 * shared onboarding copy verbatim and emits `welcome-sign-in` /
 * `welcome-chatgpt` / `welcome-api-key` / setup navigation events; the host
 * owns the funnel state.
 */
@customElement('onboarding-welcome-card')
export class OnboardingWelcomeCard extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      /* Match the inline-banner framing (see bannerStyles): wa-callout owns
         the variant color/border; we only adjust its hardcoded padding. */
      wa-callout {
        margin-bottom: var(--wa-space-s);
        padding: var(--wa-space-s) var(--wa-space-m);
      }

      .card-title {
        display: block;
        font-weight: var(--font-weight-semibold, 600);
        font-size: 1.05em;
        letter-spacing: -0.005em;
        margin-bottom: var(--wa-space-2xs);
      }

      .card-copy {
        margin: 0 0 var(--wa-space-s);
        color: var(--vscode-descriptionForeground);
        line-height: var(--line-height-normal, 1.4);
      }

      .choices {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-s);
      }

      .choice wa-button {
        width: 100%;
      }

      .choice wa-button::part(base) {
        width: 100%;
        justify-content: center;
      }

      .choice-description {
        display: block;
        margin-top: var(--wa-space-3xs);
        text-align: center;
        font-size: var(--font-size-sm);
        opacity: var(--opacity-subtle);
        line-height: var(--line-height-normal, 1.4);
      }

      .skip-row {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-s);
      }

      .skip-row wa-button::part(base) {
        font-size: var(--font-size-sm);
        opacity: var(--opacity-subtle);
      }
    `,
  ];

  private handleSignIn(): void {
    this.dispatchEvent(MainViewEvents.welcomeSignIn());
  }

  private handleApiKey(): void {
    this.dispatchEvent(MainViewEvents.welcomeApiKey());
  }

  private handleChatGpt(): void {
    this.dispatchEvent(MainViewEvents.welcomeChatGpt());
  }

  private handleSkip(): void {
    this.dispatchEvent(MainViewEvents.welcomeSkip());
  }

  private handleOpenGettingStarted(): void {
    this.dispatchEvent(MainViewEvents.onboardingOpenGettingStarted());
  }

  override render(): TemplateResult {
    return html`
      <wa-callout id="onboardingWelcomeCard" variant="brand">
        ${waIcon('wand-magic-sparkles', { slot: 'icon' })}
        <span class="card-title">${ONBOARDING_CARD_TITLE}</span>
        <p class="card-copy">
          Choose a credential first. TeXRA will start the setup assistant once
          it can call a model.
        </p>
        <div class="choices">
          <div class="choice">
            <wa-button
              id="onboardingSignInButton"
              variant="brand"
              appearance="filled"
              @click=${this.handleSignIn}
            >
              ${waIcon('right-to-bracket')} ${ONBOARDING_CHOICE_SIGN_IN.label}
            </wa-button>
            <span class="choice-description">
              ${ONBOARDING_CHOICE_SIGN_IN.description}
            </span>
          </div>
          <div class="choice">
            <wa-button
              id="onboardingChatGptButton"
              appearance="outlined"
              @click=${this.handleChatGpt}
            >
              ${waIcon('comment-discussion')} ${ONBOARDING_CHOICE_CHATGPT.label}
            </wa-button>
            <span class="choice-description">
              ${ONBOARDING_CHOICE_CHATGPT.description}
            </span>
          </div>
          <div class="choice">
            <wa-button
              id="onboardingApiKeyButton"
              appearance="outlined"
              @click=${this.handleApiKey}
            >
              ${waIcon('key')} ${ONBOARDING_CHOICE_API_KEY.label}
            </wa-button>
            <span class="choice-description">
              ${ONBOARDING_CHOICE_API_KEY.description}
            </span>
          </div>
        </div>
        <div class="skip-row">
          <wa-button
            id="onboardingWalkthroughButton"
            appearance="plain"
            size="small"
            @click=${this.handleOpenGettingStarted}
          >
            ${waIcon('book')} Open walkthrough
          </wa-button>
          <wa-button
            id="onboardingSkipButton"
            appearance="plain"
            size="small"
            @click=${this.handleSkip}
          >
            ${ONBOARDING_CHOICE_SKIP_LABEL}
          </wa-button>
        </div>
      </wa-callout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'onboarding-welcome-card': OnboardingWelcomeCard;
  }
}
