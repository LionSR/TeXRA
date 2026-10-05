/**
 * `<session-banners>`: the one warning slot above the launch composer. The
 * host raises up to four warnings (the background service offline, a
 * credential that stopped working, a missing agent file, missing tools);
 * the slot shows the first that is visible, in that order, because each
 * blocks the next: with the service away no task starts, without a key
 * nothing runs, and a missing agent file fails the launch before a tool is
 * ever needed. Each
 * warning dispatches its own `host.request` arm. The onboarding and
 * "no LaTeX files yet" cards are not warnings: they take the hero's place.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { bannerStyles, designTokens } from '@ui/styles';
import { renderWarningBanner } from '@ui/wa/bannerFrame';
import './AgentConfigBanner';
import './ApiKeyBanner';
import './DependencyBanner';

@customElement('session-banners')
export class SessionBanners extends LitElement {
  static override styles = [
    designTokens,
    bannerStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .slot {
        padding-bottom: var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) banners!: HostSnapshot['banners'];
  override render(): TemplateResult | typeof nothing {
    const { apiKey, agentConfig, dependency, serviceOffline } = this.banners;
    let warning: TemplateResult;
    if (serviceOffline) {
      warning = renderWarningBanner({
        id: 'serviceOfflineBanner',
        role: 'status',
        body: html`<span
          >The TeXRA service is offline; TeXRA is reconnecting. If another
          window runs a newer TeXRA, update this one.</span
        >`,
      });
    } else if (apiKey.visible) {
      warning = html`<api-key-banner></api-key-banner>`;
    } else if (agentConfig.visible) {
      warning = html`<agent-config-banner
        .state=${agentConfig}
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
