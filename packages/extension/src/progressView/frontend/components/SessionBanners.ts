/**
 * `<session-banners>`: the five host-owned banners (API key, agent config,
 * dependency, getting started, login) in one strip, host state read from
 * the `host` snapshot (8.1). Each banner dispatches its own `host.request`
 * arm, so the strip only hands each one the state it names. The empty state
 * renders it above the launch composer; a conversation renders it as the
 * thin strip above the follow-up (PRD 12.4).
 */
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { SessionType } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import '@webview/frontend/components/AgentConfigBanner';
import '@webview/frontend/components/ApiKeyBanner';
import '@webview/frontend/components/DependencyBanner';
import '@webview/frontend/components/GettingStartedBanner';
import '@webview/frontend/components/LoginBanner';

@customElement('session-banners')
export class SessionBanners extends LitElement {
  /* Each banner hides itself (display: none through its `visible`
     attribute), so the strip is zero height until one shows; the spacing
     below it exists only then. */
  static override styles = css`
    :host {
      display: block;
      min-width: 0;
    }
    .strip {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-2xs);
    }
    .strip:has([visible]) {
      padding-bottom: var(--wa-space-2xs);
    }
  `;

  @property({ attribute: false }) banners!: HostSnapshot['banners'];
  /** The launcher's mode, which the agent-config banner's actions name. */
  @property() sessionType: SessionType = 'toolUse';

  override render(): TemplateResult {
    const { banners } = this;
    // The agent the banner names owns its actions: a workflow agent's missing
    // configuration opens the workflow catalog even while a tool-use
    // conversation renders the strip. The launcher's mode stands in only for
    // a banner raised without one.
    const agentConfigType = banners.agentConfig.sessionType ?? this.sessionType;
    return html`
      <div class="strip">
        <api-key-banner .state=${banners.apiKey}></api-key-banner>
        <agent-config-banner
          .state=${banners.agentConfig}
          .sessionType=${agentConfigType}
        ></agent-config-banner>
        <dependency-banner .state=${banners.dependency}></dependency-banner>
        <getting-started-banner
          .visible=${banners.gettingStarted}
        ></getting-started-banner>
        <login-banner .visible=${banners.login}></login-banner>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-banners': SessionBanners;
  }
}
