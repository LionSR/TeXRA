import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

import { designTokens, commonViewStyles, bannerStyles } from '@shared/styles';
import type { DependencyBannerState } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderWarningBanner } from '@shared/wa/bannerFrame';
import { StateVisibleBanner } from './StateVisibleBanner';
import { MainViewEvents } from '../events';

@customElement('dependency-banner')
export class DependencyBanner extends StateVisibleBanner<DependencyBannerState> {
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

    return renderWarningBanner({
      id: 'dependencyBanner',
      role: 'status',
      body: html`
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
                      size="s"
                      @click=${() => this.handleInstall(tool)}
                    >
                      ${waIcon('cloud-arrow-down', { slot: 'start' })} Install
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
            size="s"
            @click=${this.handleRecheck}
          >
            ${waIcon('rotate-right', { slot: 'start' })} Re-check
          </wa-button>
          <wa-button
            id="dependencyDismissButton"
            appearance="plain"
            size="s"
            title="Dismiss (can be re-enabled in settings)"
            @click=${this.handleDismiss}
          >
            ${waIcon('xmark', { slot: 'start' })} Dismiss
          </wa-button>
        </div>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dependency-banner': DependencyBanner;
  }
}
