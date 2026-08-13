import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles, bannerStyles } from '@shared/styles';
import type { AgentConfigBannerState } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderWarningBanner } from '@shared/wa/bannerFrame';
import { StateVisibleBanner } from './StateVisibleBanner';
import { MainViewEvents } from '../events';

@customElement('agent-config-banner')
export class AgentConfigBanner extends StateVisibleBanner<AgentConfigBannerState> {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: AgentConfigBannerState = {
    visible: false,
  };

  private handleAction(action: 'edit' | 'dir' | 'docs'): void {
    this.dispatchEvent(
      MainViewEvents.agentConfigAction({
        action,
        customDirSet: this.state.customDirSet,
      }),
    );
  }

  override render(): TemplateResult {
    return renderWarningBanner({
      id: 'agentConfigBanner',
      role: 'status',
      body: html`
        <span>
          ${
            this.state.agentName
              ? `Agent file for “${this.state.agentName}” is missing.`
              : 'Agent configuration is missing.'
          }
        </span>
        <div class="actions">
          <wa-button
            id="agentConfigEditButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('edit')}
          >
            ${waIcon('pencil', { slot: 'start' })} Edit agents
          </wa-button>
          <wa-button
            id="agentConfigDirButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('dir')}
          >
            ${waIcon('folder', { slot: 'start' })}
            ${this.state.customDirSet ? 'Open directory' : 'Set directory'}
          </wa-button>
          <wa-button
            id="agentConfigDocButton"
            appearance="plain"
            size="s"
            @click=${() => this.handleAction('docs')}
          >
            ${waIcon('book', { slot: 'start' })} Open docs
          </wa-button>
        </div>
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-config-banner': AgentConfigBanner;
  }
}
