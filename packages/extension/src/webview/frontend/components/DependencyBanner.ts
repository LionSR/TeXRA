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
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { DependencyBannerState } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { applyBannerVisibility, bannerStyles } from '../styles/bannerStyles';
import { MainViewEvents } from '../events';

@customElement('dependency-banner')
export class DependencyBanner extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    bannerStyles,
    css`
      .dependency-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-2xs);
      }

      .missing-tools {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
      }
    `,
  ];

  @property({ attribute: false }) state: DependencyBannerState = {
    visible: false,
  };

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      applyBannerVisibility(this, this.state.visible);
    }
  }

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dependencyDismiss());
  }

  private handleRecheck(): void {
    this.dispatchEvent(MainViewEvents.recheckDependencies());
  }

  private handleInstall(tool: string): void {
    this.dispatchEvent(MainViewEvents.openInstallGuide({ tool }));
  }

  private getToolLabel(tool: string): string {
    switch (tool) {
      case 'gm':
        return 'GraphicsMagick';
      case 'magick':
        return 'ImageMagick';
      default:
        return tool;
    }
  }

  override render(): TemplateResult {
    const missing = this.state.missingTools ?? [];
    const tools = missing.flatMap((tool) =>
      tool === 'gm/magick' ? ['gm', 'magick'] : [tool],
    );

    return html`
      <div class="banner-frame">
        <wa-callout id="dependencyBanner" variant="warning">
          ${waIcon('triangle-exclamation', { slot: 'icon' })}
          <div class="banner-row">
            <div class="missing-tools">
              ${when(
                tools.length === 0,
                () => html`Missing dependencies: none`,
                () =>
                  repeat(
                    tools,
                    (tool) => tool,
                    (tool) => html`
                      <div class="dependency-item">
                        <span>${this.getToolLabel(tool)}</span>
                        <wa-button
                          class="dependency-install-button"
                          appearance="plain"
                          size="small"
                          @click=${() => this.handleInstall(tool)}
                        >
                          ${waIcon('cloud-arrow-down', { slot: 'start' })}
                          Install
                        </wa-button>
                      </div>
                    `,
                  ),
              )}
            </div>
            <div class="actions">
              <wa-button
                id="dependencyRecheckButton"
                appearance="plain"
                size="small"
                @click=${this.handleRecheck}
              >
                ${waIcon('rotate-right', { slot: 'start' })} Re-check
              </wa-button>
              <wa-button
                id="dependencyDismissButton"
                appearance="plain"
                size="small"
                title="Dismiss (can be re-enabled in settings)"
                @click=${this.handleDismiss}
              >
                ${waIcon('xmark', { slot: 'start' })} Dismiss
              </wa-button>
            </div>
          </div>
        </wa-callout>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dependency-banner': DependencyBanner;
  }
}
