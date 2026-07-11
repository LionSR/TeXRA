import '@awesome.me/webawesome/dist/components/button/button.js';
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { GettingStartedAction } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { bannerStyles } from '../styles/bannerStyles';
import { renderBannerFrame } from './bannerFrame';
import { MainViewEvents } from '../events';

/** Slim project-bootstrap row shown when the workspace has no LaTeX files. */
@customElement('getting-started-banner')
export class GettingStartedBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      .getting-started-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--wa-space-xs);
        font-size: var(--font-size-sm);
      }

      .getting-started-body {
        display: flex;
        flex-direction: column;
        min-width: 0;
        gap: var(--wa-space-2xs);
      }

      .getting-started-title {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
        line-height: var(--line-height-normal);
      }

      .getting-started-title strong {
        font-weight: var(--font-weight-semibold, 600);
      }

      .getting-started-title span {
        color: var(--vscode-descriptionForeground);
      }

      .getting-started-copy {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        line-height: var(--line-height-normal, 1.4);
      }

      .getting-started-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
      }

      .getting-started-actions wa-button::part(base) {
        min-height: 26px;
      }

      .dismiss-button {
        flex: 0 0 auto;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) visible = false;

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissGettingStarted());
  }

  private handleAction(action: GettingStartedAction): void {
    this.dispatchEvent(MainViewEvents.gettingStartedAction({ action }));
  }

  override render(): TemplateResult {
    return renderBannerFrame({
      id: 'gettingStartedBanner',
      variant: 'brand',
      calloutClassName: 'getting-started-banner',
      body: html`
        <div class="getting-started-row">
          <div class="getting-started-body">
            <div class="getting-started-title">
              <strong>No LaTeX files yet</strong>
              <span>Start from a sample or import an existing paper.</span>
            </div>
            <p class="getting-started-copy">
              Then run setup to connect TeXRA, check LaTeX, and choose a starter
              agent team.
            </p>
            <div class="getting-started-actions">
              <wa-button
                variant="brand"
                appearance="filled"
                size="small"
                @click=${() => this.handleAction('runSetup')}
              >
                ${waIcon('rocket', { slot: 'start' })} Run setup assistant
              </wa-button>
              <wa-button
                appearance="outlined"
                size="small"
                @click=${() => this.handleAction('createSampleProject')}
              >
                ${waIcon('file-circle-plus', { slot: 'start' })} Sample project
              </wa-button>
              <wa-button
                appearance="outlined"
                size="small"
                @click=${() => this.handleAction('cloneOverleaf')}
              >
                ${waIcon('cloud-arrow-down', { slot: 'start' })} Import Overleaf
              </wa-button>
              <wa-button
                appearance="outlined"
                size="small"
                @click=${() => this.handleAction('downloadArxiv')}
              >
                ${waIcon('download', { slot: 'start' })} Import arXiv
              </wa-button>
              <wa-button
                appearance="outlined"
                size="small"
                @click=${() => this.handleAction('openWalkthrough')}
              >
                ${waIcon('book', { slot: 'start' })} Walkthrough
              </wa-button>
            </div>
          </div>
          <wa-button
            class="dismiss-button"
            appearance="plain"
            size="small"
            title="Dismiss for this session"
            aria-label="Dismiss getting started row"
            @click=${this.handleDismiss}
          >
            ${waIcon('xmark')}
          </wa-button>
        </div>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'getting-started-banner': GettingStartedBanner;
  }
}
