import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { AgentConfigBannerState } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { applyBannerVisibility, bannerStyles } from '../styles/bannerStyles';
import { MainViewEvents } from '../events';

@customElement('agent-config-banner')
export class AgentConfigBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: AgentConfigBannerState = {
    visible: false,
  };

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      applyBannerVisibility(this, this.state.visible);
    }
  }

  private handleAction(action: 'edit' | 'dir' | 'docs'): void {
    this.dispatchEvent(
      MainViewEvents.agentConfigAction({
        action,
        customDirSet: this.state.customDirSet,
      }),
    );
  }

  override render(): TemplateResult {
    return html`
      <div class="banner-frame">
        <wa-callout
          id="agentConfigBanner"
          variant="warning"
          data-custom-dir-set=${this.state.customDirSet ? 'true' : 'false'}
        >
          ${waIcon('triangle-exclamation', { slot: 'icon' })}
          <div class="banner-row">
            <span>
              ${this.state.agentName
                ? `Agent file for "${this.state.agentName}" is missing.`
                : 'Agent configuration is missing.'}
            </span>
            <div class="actions">
              <wa-button
                id="agentConfigEditButton"
                appearance="plain"
                size="small"
                @click=${() => this.handleAction('edit')}
              >
                ${waIcon('pencil', { slot: 'start' })} Edit Agents
              </wa-button>
              <wa-button
                id="agentConfigDirButton"
                appearance="plain"
                size="small"
                @click=${() => this.handleAction('dir')}
              >
                ${waIcon('folder', { slot: 'start' })}
                ${this.state.customDirSet ? 'Open Directory' : 'Set Directory'}
              </wa-button>
              <wa-button
                id="agentConfigDocButton"
                appearance="plain"
                size="small"
                @click=${() => this.handleAction('docs')}
              >
                ${waIcon('book', { slot: 'start' })} Docs
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
    'agent-config-banner': AgentConfigBanner;
  }
}
