import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import { GETTING_STARTED_ACTION_PRESENTATION } from '@shared/schemas';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens, commonViewStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import {
  ONBOARDING_CARD_LEDE,
  ONBOARDING_CARD_TITLE,
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_CHOICE_SKIP_LABEL,
  TEXRA_TAGLINE,
} from '@ui/copy/onboarding';

const { openWalkthrough: OPEN_WALKTHROUGH } =
  GETTING_STARTED_ACTION_PRESENTATION;

/**
 * State 0 "Connect a model" card (PRD: agent-native onboarding), the one
 * credential prompt in the extension and the desktop — a port of the CLI
 * first-run picker, not a new design: ChatGPT subscription first, the API-key
 * alternative, and a quiet "Skip for now" link last. The setup assistant
 * that follows picks the agent team.
 * Stateless: renders the shared onboarding copy verbatim and emits the
 * `onboarding` host actions (`signInChatGpt`, `setApiKey`, `skip`, and
 * getting-started navigation); the host owns the funnel state.
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

  private handleApiKey(): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'onboarding', action: 'setApiKey' }),
    );
  }

  private handleChatGpt(): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'onboarding', action: 'signInChatGpt' }),
    );
  }

  private handleSkip(): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'onboarding', action: 'skip' }),
    );
  }

  private handleOpenGettingStarted(): void {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'onboarding',
        action: 'openGettingStarted',
      }),
    );
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
              <h1 class="card-title">${ONBOARDING_CARD_TITLE}</h1>
              <p class="card-copy">${TEXRA_TAGLINE} ${ONBOARDING_CARD_LEDE}</p>
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
                <span class="visually-hidden"
                  >. ${ONBOARDING_CHOICE_CHATGPT.description}</span
                >
              </wa-button>
              <span class="choice-description" aria-hidden="true">
                ${ONBOARDING_CHOICE_CHATGPT.description}
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
                <span class="visually-hidden"
                  >. ${ONBOARDING_CHOICE_API_KEY.description}</span
                >
              </wa-button>
              <span class="choice-description" aria-hidden="true">
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
