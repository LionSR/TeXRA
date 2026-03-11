import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import type { DependencyBannerState } from '@shared/schemas';
import { warningBannerStyles } from '../styles/warningBannerStyles';
import { MainViewEvents } from '../events';

@customElement('dependency-banner')
export class DependencyBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    warningBannerStyles,
    css`
      .dependency-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-small);
      }

      .missing-tools {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-tiny);
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

  private handleInstallClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-tool]',
    );
    const tool = button?.dataset.tool;
    if (tool) {
      this.dispatchEvent(MainViewEvents.openInstallGuide({ tool }));
    }
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

  override render(): TemplateResult | typeof nothing {
    if (!this.state.visible) return nothing;

    const missing = this.state.missingTools ?? [];
    const tools = missing.flatMap((tool) =>
      tool === 'gm/magick' ? ['gm', 'magick'] : [tool],
    );

    return html`
      <div id="dependencyBanner" class="warning-banner">
        <span class="missing-tools" @click=${this.handleInstallClick}>
          ${when(
            tools.length === 0,
            () => html`Missing dependencies: none`,
            () =>
              repeat(
                tools,
                (tool) => tool,
                (tool) => {
                  const label = this.getToolLabel(tool);
                  return html`
                    <div class="dependency-item">
                      <span>${label}</span>
                      <vscode-toolbar-button
                        class="btn-secondary dependency-install-button"
                        icon="cloud-download"
                        data-tool=${tool}
                      >
                        Install
                      </vscode-toolbar-button>
                    </div>
                  `;
                },
              ),
          )}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="dependencyRecheckButton"
            icon="refresh"
            @click=${this.handleRecheck}
          >
            Re-check
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="dependencyDismissButton"
            class="btn-secondary"
            title="Dismiss (can be re-enabled in settings)"
            icon="close"
            @click=${this.handleDismiss}
          >
            Dismiss
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dependency-banner': DependencyBanner;
  }
}
