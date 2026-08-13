import '@awesome.me/webawesome/dist/components/button/button.js';
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';

import { designTokens, commonViewStyles, bannerStyles } from '@shared/styles';
import {
  GETTING_STARTED_ACTION_PRESENTATION,
  type GettingStartedAction,
} from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { renderBannerFrame } from '@shared/wa/bannerFrame';
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
        color: var(--wa-color-text-quiet);
      }

      .getting-started-copy {
        margin: 0;
        color: var(--wa-color-text-quiet);
        line-height: var(--line-height-normal, 1.4);
      }

      /* Layout only — button sizing (min-height/padding-inline/
         border-radius/font-size) comes from the shared .actions rule
         in bannerStyles.ts, same as the other inline banners. */
      .getting-started-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-3xs);
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

  private renderAction(
    action: GettingStartedAction,
    appearance: 'filled' | 'outlined',
    variant?: 'brand',
  ): TemplateResult {
    const { icon, label } = GETTING_STARTED_ACTION_PRESENTATION[action];
    return html`
      <wa-button
        variant=${ifDefined(variant)}
        appearance=${appearance}
        size="s"
        @click=${() => this.handleAction(action)}
      >
        ${waIcon(icon, { slot: 'start' })} ${label}
      </wa-button>
    `;
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
            <div class="getting-started-actions actions">
              ${this.renderAction('runSetup', 'filled', 'brand')}
              ${this.renderAction('createSampleProject', 'outlined')}
              ${this.renderAction('cloneOverleaf', 'outlined')}
              ${this.renderAction('downloadArxiv', 'outlined')}
              ${this.renderAction('openWalkthrough', 'outlined')}
            </div>
          </div>
          <wa-button
            class="dismiss-button"
            appearance="plain"
            size="s"
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
