import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { GETTING_STARTED_ACTION_PRESENTATION } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  ONBOARDING_CARD_TITLE,
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_CHOICE_SIGN_IN,
  ONBOARDING_CHOICE_SKIP_LABEL,
} from '@shared/copy/onboarding';

import { MainViewEvents } from '../events';

const { openWalkthrough: OPEN_WALKTHROUGH } =
  GETTING_STARTED_ACTION_PRESENTATION;

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
        min-width: 0;
      }

      .welcome-card-container {
        min-width: 0;
        container: onboarding-card / inline-size;
      }

      wa-callout {
        box-sizing: border-box;
        display: block;
        width: 100%;
        max-width: 100%;
        margin-bottom: var(--wa-space-s);
        padding: var(--wa-space-m);
      }

      wa-callout::part(icon) {
        display: none;
      }

      .welcome-header {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: var(--wa-space-s);
        min-width: 0;
        margin-bottom: var(--wa-space-s);
      }

      .welcome-heading {
        min-width: 0;
      }

      .card-title {
        display: block;
        font-weight: var(--font-weight-semibold, 600);
        font-size: var(--font-size-lg);
        letter-spacing: -0.005em;
        line-height: var(--line-height-tight);
        margin: var(--wa-space-3xs) 0 var(--wa-space-2xs);
      }

      .card-copy {
        margin: 0;
        color: var(--wa-color-text-quiet);
        line-height: var(--line-height-normal, 1.4);
        overflow-wrap: anywhere;
      }

      .path {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
        gap: var(--wa-space-xs);
        margin: 0 0 var(--wa-space-s);
      }

      .path-step {
        min-width: 0;
        padding: var(--wa-space-xs);
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--wa-border-radius-s, 4px);
        background: color-mix(
          in srgb,
          var(--wa-color-surface-default) 76%,
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
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal, 1.4);
        overflow-wrap: anywhere;
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
        height: auto;
        min-height: var(--height-button);
        padding-block: var(--wa-space-2xs);
        justify-content: center;
        white-space: normal;
      }

      .choice wa-button::part(label) {
        display: block;
        min-width: 0;
        overflow-wrap: anywhere;
        white-space: normal !important;
        text-align: center;
      }

      .choice-description {
        display: block;
        margin-top: var(--wa-space-3xs);
        text-align: center;
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal, 1.4);
        color: var(--wa-color-text-quiet);
        overflow-wrap: anywhere;
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
      }

      @container onboarding-card (max-width: 420px) {
        wa-callout {
          padding: var(--wa-space-xs);
        }

        .welcome-header {
          grid-template-columns: 1fr;
          gap: var(--wa-space-xs);
        }

        .welcome-icon {
          display: none;
        }

        .path {
          gap: var(--wa-space-2xs);
          margin-bottom: var(--wa-space-xs);
        }

        .path-step {
          display: grid;
          grid-template-columns: minmax(86px, auto) minmax(0, 1fr);
          gap: var(--wa-space-xs);
          padding: var(--wa-space-2xs);
        }

        .path-step__label {
          margin-bottom: 0;
        }

        .choices {
          gap: var(--wa-space-xs);
        }

        .choice wa-button {
          font-size: var(--font-size-sm);
        }

        .choice-description {
          text-align: start;
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
      <div class="welcome-card-container">
        <wa-callout id="onboardingWelcomeCard" variant="brand">
          <div class="welcome-header">
            <span
              class="welcome-icon icon-surface is-size-l"
              aria-hidden="true"
            >
              ${waIcon('wand-magic-sparkles')}
            </span>
            <div class="welcome-heading">
              <span class="card-title">${ONBOARDING_CARD_TITLE}</span>
              <p class="card-copy">
                Start with one credential. TeXRA then checks this project, picks
                the right agent team, and starts your first useful edit.
              </p>
            </div>
          </div>
          <div class="path" role="list" aria-label="Getting started path">
            <div class="path-step" role="listitem">
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
            <div class="path-step" role="listitem">
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
            <div class="path-step" role="listitem">
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
                ${waIcon('comments', { slot: 'start' })}
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
              ${waIcon(OPEN_WALKTHROUGH.icon, { slot: 'start' })}
              ${OPEN_WALKTHROUGH.label}
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
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'onboarding-welcome-card': OnboardingWelcomeCard;
  }
}
