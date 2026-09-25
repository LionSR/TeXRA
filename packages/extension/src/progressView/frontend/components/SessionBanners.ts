/**
 * `<session-banners>`: the one warning slot above the launch composer. The
 * host raises up to three warnings (no usable API key, a missing agent
 * file, missing tools); the slot shows the first that is visible, in that
 * order, because each blocks the next: without a key nothing runs, and a
 * missing agent file fails the launch before a tool is ever needed. Each
 * warning dispatches its own `host.request` arm. The onboarding and
 * "no LaTeX files yet" cards are not warnings: they take the hero's place.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { SessionType } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import './AgentConfigBanner';
import './ApiKeyBanner';
import './DependencyBanner';

@customElement('session-banners')
export class SessionBanners extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-width: 0;
    }
    .slot {
      padding-bottom: var(--wa-space-2xs);
    }
  `;

  @property({ attribute: false }) banners!: HostSnapshot['banners'];
  /** The launcher's mode, which the agent-config banner's actions name. */
  @property() sessionType: SessionType = 'toolUse';

  override render(): TemplateResult | typeof nothing {
    const { apiKey, agentConfig, dependency } = this.banners;
    let warning: TemplateResult;
    if (apiKey.visible) {
      warning = html`<api-key-banner .state=${apiKey}></api-key-banner>`;
    } else if (agentConfig.visible) {
      // The agent the banner names owns its actions: a workflow agent's
      // missing file opens the workflow catalog. The launcher's mode stands
      // in only for a banner raised without one.
      warning = html`<agent-config-banner
        .state=${agentConfig}
        .sessionType=${agentConfig.sessionType ?? this.sessionType}
      ></agent-config-banner>`;
    } else if (dependency.visible) {
      warning = html`<dependency-banner
        .state=${dependency}
      ></dependency-banner>`;
    } else {
      return nothing;
    }
    return html`<div class="slot">${warning}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-banners': SessionBanners;
  }
}
