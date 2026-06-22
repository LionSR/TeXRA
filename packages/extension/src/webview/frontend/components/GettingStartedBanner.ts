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

import { applyBannerVisibility, bannerStyles } from '../styles/bannerStyles';
import { MainViewEvents } from '../events';

/** Slim project-bootstrap row shown when the workspace has no LaTeX files. */
@customElement('getting-started-banner')
export class GettingStartedBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      wa-callout.getting-started-banner a {
        text-decoration: none;
      }

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

      .getting-started-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
      }

      .action-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--wa-space-3xs);
        min-height: 24px;
        max-width: 100%;
        padding: 2px var(--wa-space-xs);
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: var(--wa-border-radius-s, 4px);
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        line-height: var(--line-height-normal);
        white-space: nowrap;
      }

      .action-link:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      .action-link--primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .action-link--primary:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .dismiss-button {
        flex: 0 0 auto;
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('visible')) {
      applyBannerVisibility(this, this.visible);
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
          <div class="getting-started-row">
            <div class="getting-started-body">
              <div class="getting-started-title">
                <strong>Empty project</strong>
                <span>Start with setup or bring in a LaTeX source.</span>
              </div>
              <div class="getting-started-actions">
                <a
                  class="action-link action-link--primary"
                  href=${COMMAND_LINKS.RUN_SETUP_ASSISTANT}
                >
                  ${waIcon('rocket')} Run setup
                </a>
                <a
                  class="action-link"
                  href=${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}
                >
                  ${waIcon('file-circle-plus')} Sample project
                </a>
                <a class="action-link" href=${COMMAND_LINKS.CLONE_OVERLEAF}>
                  ${waIcon('cloud-arrow-down')} Overleaf
                </a>
                <a class="action-link" href=${COMMAND_LINKS.DOWNLOAD_ARXIV}>
                  ${waIcon('download')} arXiv
                </a>
                <a class="action-link" href=${COMMAND_LINKS.GETTING_STARTED}>
                  ${waIcon('book')} Walkthrough
                </a>
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
