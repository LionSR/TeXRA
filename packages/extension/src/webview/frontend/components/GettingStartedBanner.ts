import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { COMMAND_LINKS } from '@shared/utils/uiConstants';

import { bannerStyles } from '../styles/bannerStyles';
import { MainViewEvents } from '../events';

@customElement('getting-started-banner')
export class GettingStartedBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      wa-callout.getting-started-banner a {
        color: var(--color-text-link);
        text-decoration: none;
      }

      wa-callout.getting-started-banner a:hover {
        text-decoration: underline;
      }

      .getting-started-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-small);
      }

      .getting-started-list {
        margin: var(--spacing-tiny) 0 0 0;
        padding-left: var(--spacing-large);
        line-height: var(--line-height-relaxed);
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissGettingStarted());
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return html`
      <wa-callout
        id="gettingStartedBanner"
        class="getting-started-banner"
        variant="brand"
      >
        ${waIcon('lightbulb', { slot: 'icon' })}
        <div class="getting-started-header">
          <span>
            <strong>Welcome to TeXRA!</strong> No LaTeX files here yet — pick
            how you'd like to start:
          </span>
          <wa-button
            appearance="plain"
            size="small"
            title="Dismiss (can be re-enabled in settings)"
            aria-label="Dismiss getting started banner"
            @click=${this.handleDismiss}
          >
            ${waIcon('xmark')}
          </wa-button>
        </div>
        <ul class="getting-started-list">
          <li>
            <a href=${COMMAND_LINKS.RUN_SETUP_ASSISTANT}>
              Run the setup assistant agent
            </a>
            -- checks tools, credentials, and LaTeX setup
          </li>
          <li>
            <a href=${COMMAND_LINKS.GETTING_STARTED}>Walk me through setup</a>
            -- takes a few minutes
          </li>
          <li>
            <a href=${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}>
              Try the sample project
            </a>
            -- play around risk-free
          </li>
          <li>
            <a href=${COMMAND_LINKS.CLONE_OVERLEAF}>Pull from Overleaf</a>
            -- import an existing project
          </li>
          <li>
            <a href=${COMMAND_LINKS.DOWNLOAD_ARXIV}>Grab from arXiv</a>
            -- download a paper's source
          </li>
        </ul>
      </wa-callout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'getting-started-banner': GettingStartedBanner;
  }
}
