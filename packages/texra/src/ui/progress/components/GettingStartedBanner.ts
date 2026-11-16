import { html, css, LitElement, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

import type { GettingStartedAction } from '@texra/shared/session/hostRequest';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { GETTING_STARTED_ACTION_PRESENTATION } from '@ui/copy/onboarding';
import { designTokens, commonViewStyles, bannerStyles } from '@ui/styles';

import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
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
        gap: var(--wa-space-xs);
      }

      .getting-started-title {
        margin: 0;
        line-height: var(--line-height-normal);
      }

      .getting-started-title strong {
        font-weight: var(--font-weight-semibold);
      }

      .getting-started-copy {
        margin: 0;
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      /* Layout only — button sizing (min-height/padding-inline/
         border-radius/font-size) comes from the shared .actions rule
         in bannerStyles.ts, same as the other inline banners. */
      .getting-started-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-xs);
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
    kind: 'secondary' | 'ghost',
  ): TemplateResult {
    const { icon, label } = GETTING_STARTED_ACTION_PRESENTATION[action];
    return renderLabeledActionButton({
      icon,
      text: label,
      kind,
      onClick: () => this.handleAction(action),
    });
  }

  override render(): TemplateResult {
    return renderBannerFrame({
      id: 'gettingStartedBanner',
      variant: 'neutral',
      appearance: 'outlined',
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
              ${this.renderAction('createSampleProject', 'secondary')}
              ${this.renderAction('cloneOverleaf', 'ghost')}
              ${this.renderAction('downloadArxiv', 'ghost')}
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
