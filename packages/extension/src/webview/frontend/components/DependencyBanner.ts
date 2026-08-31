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
        margin: 0;
        padding: 0;
        list-style: none;
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
    const imageToolMissing = missing.includes('gm/magick');

    return renderWarningBanner({
      id: 'dependencyBanner',
      role: 'status',
      body: html`
        ${when(
          tools.length === 0,
          () => html`<span>No dependencies are missing.</span>`,
          () => html`
            <span>Missing dependencies:</span>
            <ul class="missing-tools">
              ${repeat(
                tools,
                (tool) => tool,
                (tool) => {
                  const label = this.getToolLabel(tool);

                  return html`
                    <li class="dependency-item">
                      <span
                        ><bdi dir="auto">${label}</bdi>${
                          imageToolMissing &&
                          (tool === 'gm' || tool === 'magick')
                            ? ' (choose one)'
                            : ''
                        }</span
                      >
                      <wa-button
                        class="dependency-install-button"
                        appearance="plain"
                        size="s"
                        aria-label=${`Open ${label} install guide`}
                        @click=${() => this.handleInstall(tool)}
                      >
                        ${waIcon('book', { slot: 'start' })} Install guide
                      </wa-button>
                    </li>
                  `;
                },
              )}
            </ul>
          `,
        )}
        <div class="actions">
          <wa-button
            id="dependencyRecheckButton"
            appearance="plain"
            size="s"
            @click=${this.handleRecheck}
          >
            ${waIcon('rotate-right', { slot: 'start' })} Check again
          </wa-button>
          <wa-button
            id="dependencyDismissButton"
            appearance="plain"
            size="s"
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
