/**
 * `<session-banners>`: the five host-owned banners (API key, agent config,
 * dependency, getting started, login) in one strip, host state read from
 * the `host` snapshot (8.1) and every action dispatched as the
 * `host.request` arm it names. The empty state renders it above the launch
 * composer; a conversation renders it as the thin strip above the follow-up
 * (PRD 12.4).
 */
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  AgentConfigBannerActionDetail,
  ApiKeyBannerActionDetail,
  GettingStartedActionDetail,
  InstallGuideDetail,
  SessionType,
} from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { SessionUiEvents } from '@shared/session/uiEvents';
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

  private request(request: Parameters<typeof SessionUiEvents.host>[0]): void {
    this.dispatchEvent(SessionUiEvents.host(request));
  }

  override render(): TemplateResult {
    const { banners } = this;
    return html`
      <div
        class="strip"
        @api-key-action=${({ detail }: CustomEvent<ApiKeyBannerActionDetail>) =>
          this.request({
            kind: 'apiKeyBanner',
            action: detail.action,
            provider: banners.apiKey.provider,
          })}
        @agent-config-action=${({
          detail,
        }: CustomEvent<AgentConfigBannerActionDetail>) =>
          this.request({
            kind: 'agentConfigBanner',
            action: detail.action,
            sessionType: this.sessionType,
            customDirSet: banners.agentConfig.customDirSet,
          })}
        @dependency-dismiss=${() =>
          this.request({ kind: 'dismissBanner', banner: 'dependency' })}
        @recheck-dependencies=${() =>
          this.request({ kind: 'recheckDependencies' })}
        @open-install-guide=${({ detail }: CustomEvent<InstallGuideDetail>) =>
          this.request({ kind: 'openInstallGuide', tool: detail.tool })}
        @sign-in=${() => this.request({ kind: 'signIn' })}
        @dismiss-login=${() =>
          this.request({ kind: 'dismissBanner', banner: 'login' })}
        @dismiss-getting-started=${() =>
          this.request({ kind: 'dismissBanner', banner: 'gettingStarted' })}
        @getting-started-action=${({
          detail,
        }: CustomEvent<GettingStartedActionDetail>) =>
          this.request({ kind: 'gettingStarted', action: detail.action })}
      >
        <api-key-banner .state=${banners.apiKey}></api-key-banner>
        <agent-config-banner
          .state=${banners.agentConfig}
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
