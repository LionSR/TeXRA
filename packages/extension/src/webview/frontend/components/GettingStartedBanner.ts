import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import {
  LitElement,
  html,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
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
        font-weight: var(--font-weight-medium, 500);
        border-bottom: 1px dotted
          color-mix(in srgb, currentColor 40%, transparent);
        transition: border-color 120ms ease;
      }

      wa-callout.getting-started-banner a:hover {
        border-bottom-color: currentColor;
      }

      .getting-started-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-2xs);
      }

      .getting-started-list {
        margin: var(--wa-space-2xs) 0 0 0;
        padding-left: var(--wa-space-m);
        line-height: var(--line-height-relaxed);
      }

      .getting-started-list li {
        font-size: var(--font-size-sm);
        margin-block: 1px;
      }

      .getting-started-list li::marker {
        color: color-mix(
          in srgb,
          var(--wa-color-brand-fill-loud) 60%,
          transparent
        );
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('visible')) {
      this.dataset.visible = this.visible ? 'true' : 'false';
      this.setAttribute('aria-hidden', this.visible ? 'false' : 'true');
    }
  }

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissGettingStarted());
  }

  override render(): TemplateResult {
    return html`
      <div class="banner-frame">
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
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'getting-started-banner': GettingStartedBanner;
  }
}
