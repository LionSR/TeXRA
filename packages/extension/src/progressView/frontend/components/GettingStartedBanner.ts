import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, css, LitElement, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';

import {
  GETTING_STARTED_ACTION_PRESENTATION,
  type GettingStartedAction,
} from '@shared/schemas';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens, commonViewStyles, bannerStyles } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import { renderIconActionButton } from '@ui/wa/actionButtons';
import { renderBannerFrame } from '@ui/wa/bannerFrame';

/** The New-task hero while the folder has no LaTeX files: start a project.
 *  Setup and the walkthrough have their own homes (the setup hero, the
 *  command palette), so this card offers only the ways to get a paper in. */
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
        margin: 0;
        line-height: var(--line-height-normal);
      }

      .getting-started-title strong {
        font-weight: var(--font-weight-semibold, 600);
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

  private handleDismiss(): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'dismissBanner', banner: 'gettingStarted' }),
    );
  }

  private handleAction(action: GettingStartedAction): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'gettingStarted', action }),
    );
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
            <p class="getting-started-title">
              <strong>No LaTeX files yet</strong>
            </p>
            <p class="getting-started-copy">
              Start from a sample, or bring a paper in from Overleaf or arXiv.
            </p>
            <div
              class="getting-started-actions actions"
              role="group"
              aria-label="Getting started actions"
            >
              ${this.renderAction('createSampleProject', 'filled', 'brand')}
              ${this.renderAction('cloneOverleaf', 'outlined')}
              ${this.renderAction('downloadArxiv', 'outlined')}
            </div>
          </div>
          ${renderIconActionButton({
            icon: 'xmark',
            label: 'Dismiss getting started for this session',
            title: 'Dismiss for this session',
            className: 'dismiss-button',
            onClick: this.handleDismiss,
          })}
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
