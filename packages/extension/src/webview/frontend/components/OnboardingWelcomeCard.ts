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
 * first-run picker, not a new design: ChatGPT subscription first, Researcher
 * Access/API-key alternatives, and a quiet "Skip for now" link last.
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

      wa-callout::part(icon) {
        align-items: flex-start;
      }

      .welcome-icon {
        margin-top: var(--wa-space-3xs);
      }

      .card-title {
        display: block;
        font-weight: var(--font-weight-semibold, 600);
        font-size: var(--font-size-lg);
        letter-spacing: -0.005em;
        line-height: var(--line-height-tight);
        margin-bottom: var(--wa-space-2xs);
      }

      .card-copy {
        margin: 0 0 var(--wa-space-s);
        color: var(--vscode-descriptionForeground);
        line-height: var(--line-height-normal, 1.4);
      }

      .path {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--wa-space-xs);
        margin: 0 0 var(--wa-space-s);
      }

      .path-step {
        min-width: 0;
        padding: var(--wa-space-xs);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: var(--wa-border-radius-s, 4px);
        background: color-mix(
          in srgb,
          var(--vscode-editor-background) 76%,
          transparent
        );
      }

      .path-step__label {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-bottom: var(--wa-space-3xs);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-semibold, 600);
      }

      .path-step__copy {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: var(--font-size-sm);
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

      @media (max-width: 520px) {
        .path {
          grid-template-columns: 1fr;
        }
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
        <span
          slot="icon"
          class="welcome-icon icon-surface is-size-l"
          aria-hidden="true"
        >
          ${waIcon('wand-magic-sparkles')}
        </span>
        <span class="card-title">${ONBOARDING_CARD_TITLE}</span>
        <p class="card-copy">
          Start with one credential. TeXRA then checks this project, picks the
          right agent team, and starts your first useful edit.
        </p>
        <div class="path" aria-label="Getting started path">
          <div class="path-step">
            <span class="path-step__label">
              <span class="icon-surface is-size-s" aria-hidden="true">
                ${waIcon('right-to-bracket')}
              </span>
              <span>1. Connect</span>
            </span>
            <p class="path-step__copy">
              ChatGPT subscription, Researcher Access, or a provider API key.
            </p>
          </div>
          <div class="path-step">
            <span class="path-step__label">
              <span class="icon-surface is-size-s" aria-hidden="true">
                ${waIcon('rocket')}
              </span>
              <span>2. Setup</span>
            </span>
            <p class="path-step__copy">
              The setup assistant checks LaTeX and applies a starter team.
            </p>
          </div>
          <div class="path-step">
            <span class="path-step__label">
              <span class="icon-surface is-size-s" aria-hidden="true">
                ${waIcon('code-compare')}
              </span>
              <span>3. Review</span>
            </span>
            <p class="path-step__copy">
              Run a polish pass and inspect the diff before accepting changes.
            </p>
          </div>
        </div>
        <div class="choices">
          <div class="choice">
            <wa-button
              id="onboardingChatGptButton"
              class="btn-primary"
              variant="brand"
              appearance="filled"
              size="m"
              @click=${this.handleChatGpt}
            >
              ${waIcon('comment-discussion', { slot: 'start' })}
              ${ONBOARDING_CHOICE_CHATGPT.label}
            </wa-button>
            <span class="choice-description">
              ${ONBOARDING_CHOICE_CHATGPT.description}
            </span>
          </div>
          <div class="choice">
            <wa-button
              id="onboardingSignInButton"
              class="btn-secondary"
              appearance="outlined"
              size="m"
              @click=${this.handleSignIn}
            >
              ${waIcon('right-to-bracket', { slot: 'start' })}
              ${ONBOARDING_CHOICE_SIGN_IN.label}
            </wa-button>
            <span class="choice-description">
              ${ONBOARDING_CHOICE_SIGN_IN.description}
            </span>
          </div>
          <div class="choice">
            <wa-button
              id="onboardingApiKeyButton"
              class="btn-secondary"
              appearance="outlined"
              size="m"
              @click=${this.handleApiKey}
            >
              ${waIcon('key', { slot: 'start' })}
              ${ONBOARDING_CHOICE_API_KEY.label}
            </wa-button>
            <span class="choice-description">
              ${ONBOARDING_CHOICE_API_KEY.description}
            </span>
          </div>
        </div>
        <div class="skip-row">
          <wa-button
            id="onboardingWalkthroughButton"
            class="btn-ghost"
            appearance="plain"
            size="s"
            @click=${this.handleOpenGettingStarted}
          >
            ${waIcon('book', { slot: 'start' })} Open walkthrough
          </wa-button>
          <wa-button
            id="onboardingSkipButton"
            class="btn-ghost"
            appearance="plain"
            size="s"
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
