import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import type { AgentConfigBannerState } from '@shared/schemas';
import { warningBannerStyles } from '../styles/warningBannerStyles';
import { MainViewEvents } from '../events';

@customElement('agent-config-banner')
export class AgentConfigBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    warningBannerStyles,
  ];

  @property({ attribute: false }) state: AgentConfigBannerState = {
    visible: false,
  };

  private handleActionClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-action]',
    );
    const action = button?.dataset.action as
      | 'edit'
      | 'dir'
      | 'docs'
      | undefined;
    if (!action) return;
    this.dispatchEvent(
      MainViewEvents.agentConfigAction({
        action,
        customDirSet: this.state.customDirSet,
      }),
    );
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.state.visible) return nothing;

    return html`
      <div
        id="agentConfigBanner"
        class="warning-banner"
        data-custom-dir-set=${this.state.customDirSet ? 'true' : 'false'}
      >
        <span>
          ${this.state.agentName
            ? `Agent file for "${this.state.agentName}" is missing.`
            : 'Agent configuration is missing.'}
        </span>
        <div class="actions" @click=${this.handleActionClick}>
          <vscode-toolbar-button
            id="agentConfigEditButton"
            icon="edit"
            data-action="edit"
          >
            Edit Agents
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDirButton"
            icon="folder"
            data-action="dir"
          >
            ${this.state.customDirSet ? 'Open Directory' : 'Set Directory'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDocButton"
            icon="book"
            data-action="docs"
          >
            Docs
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-config-banner': AgentConfigBanner;
  }
}
