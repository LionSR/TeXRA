/**
 * `<session-banners>`: the one warning slot above the launch composer. The
 * host raises up to five warnings (the background service offline, a
 * credential that stopped working, a missing agent file, missing tools, a
 * folder's tasks running in this window only); the slot shows the first
 * that is visible, in that order, because each blocks the next: with the
 * service away no task starts, without a key nothing runs, and a missing
 * agent file fails the launch before a tool is ever needed. Tasks running
 * in this window still run, so that notice yields to every other. Each
 * warning dispatches its own `host.request` arm. The onboarding and
 * "no LaTeX files yet" cards are not warnings: they take the hero's place.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
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
    const { apiKey, agentConfig, dependency, service } = this.banners;
    let warning: TemplateResult;
    if (service?.kind === 'offline') {
      warning = renderWarningBanner({
        id: 'serviceOfflineBanner',
        role: 'status',
        body: html`<span>${service.reason}</span>`,
      });
    } else if (apiKey) {
      warning = html`<api-key-banner></api-key-banner>`;
    } else if (agentConfig !== null) {
      warning = html`<agent-config-banner
        .state=${agentConfig}
      ></agent-config-banner>`;
    } else if (dependency !== null) {
      warning = html`<dependency-banner
        .missingTools=${dependency}
      ></dependency-banner>`;
    } else if (service?.kind === 'local') {
      warning = renderWarningBanner({
        id: 'serviceLocalBanner',
        role: 'status',
        body: html`<span>${service.reason}</span>`,
      });
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
