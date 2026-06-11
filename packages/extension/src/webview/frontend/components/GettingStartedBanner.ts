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
        color: var(--color-text-link);
        text-decoration: none;
        font-weight: var(--font-weight-medium, 500);
        border-bottom: 1px dotted
          color-mix(in srgb, currentColor 40%, transparent);
        transition: border-color var(--transition-fast);
      }

      wa-callout.getting-started-banner a:hover {
        border-bottom-color: currentColor;
      }

      .getting-started-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-sm);
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
            <span>
              Empty folder —
              <a href=${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}>Sample project</a>
              ·
              <a href=${COMMAND_LINKS.CLONE_OVERLEAF}>Pull from Overleaf</a>
              ·
              <a href=${COMMAND_LINKS.DOWNLOAD_ARXIV}>Grab from arXiv</a>
              — or just ask below.
            </span>
            <wa-button
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
