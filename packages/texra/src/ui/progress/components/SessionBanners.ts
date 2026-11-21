/**
 * `<session-banners>`: the one warning slot above the launch composer. The
 * host raises up to five warnings (the background service offline, a
 * credential that stopped working, a missing agent file, missing tools, a
 * folder's tasks running in this window only); the slot shows the first
 * that is visible, in that order, because each blocks the next: with the
 * service away no task starts, without a key nothing runs, and a missing
 * agent file fails the launch before a tool is ever needed. Tasks running
 * in this window still run, so that notice yields to every other. Each
 * warning dispatches its own `host.request` command. The onboarding and
 * "no LaTeX files yet" cards are not warnings: they take the hero's place.
 */
import { css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import {
  CREDENTIAL_LOST_NOTICE,
  ONBOARDING_CHOICE_CHATGPT,
} from '@ui/copy/onboarding';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { bannerStyles } from '@ui/styles';
import { TexraElement } from '@ui/litBase';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderWarningBanner } from '@ui/wa/bannerFrame';
import './DependencyBanner';

@customElement('session-banners')
export class SessionBanners extends TexraElement {
  static override styles = [
    TexraElement.styles,
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

  private send(command: HostCommand): void {
    this.dispatchEvent(SessionUiEvents.host(command));
  }

  /** Shown only once a credential that worked stops working (the host raises
   *  it after a first task has finished). Until then the "Connect a model"
   *  card is the one prompt, so the banner never repeats it on a first
   *  install. Its first action is the card's first choice, so reconnecting
   *  offers both ways to connect, not only one. */
  private apiKeyBanner(): TemplateResult {
    return renderWarningBanner({
      id: 'apiKeyBanner',
      role: 'alert',
      body: html`
        <span>${CREDENTIAL_LOST_NOTICE}</span>
        <div class="actions">
          ${renderLabeledActionButton({
            id: 'apiKeyBannerChatGptButton',
            icon: 'right-to-bracket',
            text: ONBOARDING_CHOICE_CHATGPT.label,
            onClick: () =>
              this.send({ kind: 'onboarding', action: 'signInChatGpt' }),
          })}
          ${renderLabeledActionButton({
            id: 'apiKeyBannerButton',
            icon: 'key',
            text: 'Set API key',
            onClick: () => this.send({ kind: 'apiKeyBanner', action: 'set' }),
          })}
          ${renderLabeledActionButton({
            id: 'apiKeyGuideButton',
            icon: 'book',
            text: 'Open key guide',
            onClick: () => this.send({ kind: 'apiKeyBanner', action: 'guide' }),
          })}
        </div>
        <span class="hint">
          A ChatGPT subscription covers OpenAI models. Other chat subscriptions
          don't include API access; for those models, use a provider key.
        </span>
      `,
    });
  }

  private agentConfigBanner(
    state: NonNullable<HostSnapshot['banners']['agentConfig']>,
  ): TemplateResult {
    const send = (action: 'edit' | 'dir' | 'docs') =>
      this.send({
        kind: 'agentConfigBanner',
        action,
        customDirSet: state.customDirSet,
      });
    // prettier-ignore
    const message = html`Agent file for “<bdi dir="auto">${state.agentName}</bdi>” is missing.`;
    return renderWarningBanner({
      id: 'agentConfigBanner',
      role: 'status',
      body: html`
        <span>${message}</span>
        <div class="actions">
          ${renderLabeledActionButton({
            id: 'agentConfigEditButton',
            icon: 'pencil',
            text: 'Edit agents',
            onClick: () => send('edit'),
          })}
          ${renderLabeledActionButton({
            id: 'agentConfigDirButton',
            icon: 'folder',
            text: state.customDirSet
              ? 'Open agent directory'
              : 'Set agent directory',
            onClick: () => send('dir'),
          })}
          ${renderLabeledActionButton({
            id: 'agentConfigDocButton',
            icon: 'book',
            text: 'Read agent docs',
            onClick: () => send('docs'),
          })}
        </div>
      `,
    });
  }

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
      warning = this.apiKeyBanner();
    } else if (agentConfig !== null) {
      warning = this.agentConfigBanner(agentConfig);
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
