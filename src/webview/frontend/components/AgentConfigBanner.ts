// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';

// Local imports - main view
import { bannerStyles } from '@webview/frontend/styles';

export type AgentConfigBannerAction = 'edit' | 'dir' | 'docs';

export interface AgentConfigBannerActionDetail {
  action: AgentConfigBannerAction;
}

@customElement('agent-config-banner')
export class AgentConfigBanner extends LitElement {
  static styles = [designTokens, commonViewStyles, codiconStyles, bannerStyles];

  @property({ type: Boolean }) visible = false;
  @property({ type: String }) agentName = '';
  @property({ type: Boolean }) customDirSet = false;

  private emitAction(action: AgentConfigBannerAction): void {
    this.dispatchEvent(
      new CustomEvent<AgentConfigBannerActionDetail>(
        'agent-config-banner-action',
        {
          detail: { action },
          bubbles: true,
          composed: true,
        },
      ),
    );
  }

  private handleActionClick = (event: Event): void => {
    const target = event.currentTarget as HTMLElement | null;
    const action = target?.dataset.action as
      | AgentConfigBannerAction
      | undefined;
    if (!action) return;
    this.emitAction(action);
  };

  render(): TemplateResult {
    return html`
      <div
        id="agentConfigBanner"
        class="agent-config-banner"
        style=${this.visible ? 'display: flex' : 'display: none'}
        data-custom-dir-set=${this.customDirSet ? 'true' : 'false'}
      >
        <span>
          ${this.agentName
            ? `Agent file for "${this.agentName}" is missing.`
            : 'Agent configuration is missing.'}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="agentConfigEditButton"
            icon="edit"
            data-action="edit"
            @click=${this.handleActionClick}
          >
            Edit Agents
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDirButton"
            icon="folder"
            data-action="dir"
            @click=${this.handleActionClick}
          >
            ${this.customDirSet ? 'Open Directory' : 'Set Directory'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDocButton"
            icon="book"
            data-action="docs"
            @click=${this.handleActionClick}
          >
            Docs
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}
