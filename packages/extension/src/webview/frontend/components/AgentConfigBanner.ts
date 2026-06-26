import '@awesome.me/webawesome/dist/components/button/button.js';
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
import { bannerStyles } from '../styles/bannerStyles';
import { renderWarningBanner } from './bannerFrame';
import { MainViewEvents } from '../events';

@customElement('agent-config-banner')
export class AgentConfigBanner extends LitElement {
  static override styles = [designTokens, commonViewStyles, bannerStyles];

  @property({ attribute: false }) state: AgentConfigBannerState = {
    visible: false,
  };

  /** Reflected to the host so bannerStyles can hide the banner via CSS. */
  @property({ type: Boolean, reflect: true }) visible = false;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('state')) {
      this.visible = this.state.visible;
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
    return renderWarningBanner({
      id: 'agentConfigBanner',
      body: html`
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
      `,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agent-config-banner': AgentConfigBanner;
  }
}
