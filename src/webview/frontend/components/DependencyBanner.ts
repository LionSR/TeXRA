// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { bannerStyles } from '@webview/frontend/styles';

export type DependencyBannerAction = 'recheck' | 'dismiss' | 'install';

export interface DependencyBannerActionDetail {
  action: DependencyBannerAction;
  tool?: string;
}

@customElement('dependency-banner')
export class DependencyBanner extends LitElement {
  static styles = [designTokens, commonViewStyles, codiconStyles, bannerStyles];

  @property({ type: Boolean }) visible = false;
  @property({ type: Array }) missingTools: string[] = [];

  private emitAction(detail: DependencyBannerActionDetail): void {
    this.dispatchEvent(
      new CustomEvent<DependencyBannerActionDetail>(
        'dependency-banner-action',
        {
          detail,
          bubbles: true,
          composed: true,
        },
      ),
    );
  }

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as DependencyBannerAction | undefined;
    const tool = target?.dataset.tool;
    if (!action) return;
    this.emitAction({ action, tool });
  };

  private renderDependencyContent(): TemplateResult {
    if (this.missingTools.length === 0) {
      return html`Missing dependencies: none`;
    }

    const tools = this.missingTools.flatMap((tool) =>
      tool === 'gm/magick' ? ['gm', 'magick'] : [tool],
    );

    return html`${repeat(
      tools,
      (tool) => tool,
      (tool) => {
        const label =
          tool === 'gm'
            ? 'GraphicsMagick'
            : tool === 'magick'
              ? 'ImageMagick'
              : tool;
        return html`
          <div class="dependency-item">
            <span>${label}</span>
            <vscode-toolbar-button
              class="btn-secondary dependency-install-button"
              icon="cloud-download"
              data-action="install"
              data-tool=${tool}
              @click=${this.handleActionClick}
            >
              Install
            </vscode-toolbar-button>
          </div>
        `;
      },
    )}`;
  }

  render(): TemplateResult {
    return html`
      <div
        id="dependencyBanner"
        class="dependency-banner"
        style=${this.visible ? 'display: flex' : 'display: none'}
      >
        <span class="missing-tools"> ${this.renderDependencyContent()} </span>
        <div class="actions">
          <vscode-toolbar-button
            id="dependencyRecheckButton"
            icon="refresh"
            data-action="recheck"
            @click=${this.handleActionClick}
          >
            Re-check
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="dependencyDismissButton"
            class="btn-secondary"
            title="Dismiss (can be re-enabled in settings)"
            icon="close"
            data-action="dismiss"
            @click=${this.handleActionClick}
          >
            Dismiss
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}
