/**
 * The Sessions drawer (PRD 12.1): a slide-over with a scrim, headed by the
 * paper name with search and close, the real `<stream-tabs>` in group
 * sections as its body, and "Open sessions in editor" as its footer. New
 * task has one home, the shell header; the drawer carries no second one.
 *
 * `Surface.drawerOpen` opens it and `Surface.search` filters it; both reach
 * the root as `surface-action` events. The docked list of the wide editor
 * tab is the same body inside `<progress-app>`, never this element.
 */
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import './StreamTabs';

@customElement('session-drawer')
export class SessionDrawer extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        position: absolute;
        inset: 0;
        z-index: 4;
        display: block;
      }

      .scrim {
        position: absolute;
        inset: 0;
        background: var(--wa-color-overlay-modal);
      }

      .panel {
        position: absolute;
        top: 0;
        bottom: 0;
        inset-inline-start: 0;
        width: min(320px, 100% - 40px);
        display: flex;
        flex-direction: column;
        background: var(--wa-color-surface-default);
        color: var(--wa-color-text-normal);
        border-inline-end: var(--border-thin) solid
          var(--wa-color-surface-border);
        box-shadow: var(--wa-shadow-l);
      }

      .drawer-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 0 0 auto;
        min-height: var(--height-header, 38px);
        padding: 0 var(--wa-space-2xs) 0 var(--wa-space-xs);
        border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
      }

      .drawer-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: var(--font-weight-semibold);
      }

      .drawer-search {
        flex: 0 0 auto;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
      }

      .drawer-body {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: var(--wa-space-3xs);
      }

      .drawer-footer {
        flex: 0 0 auto;
        border-top: var(--border-thin) solid var(--wa-color-surface-border);
      }

      .drawer-footer wa-button {
        width: 100%;
      }

      .drawer-footer wa-button::part(base) {
        justify-content: flex-start;
        gap: var(--wa-space-2xs);
        padding-inline: var(--wa-space-xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }
    `,
  ];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;

  private close = (): void => {
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'drawer', open: false }),
    );
  };

  private handleSearchInput = (event: Event): void => {
    const value = (event.target as HTMLInputElement).value;
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'search', value }));
  };

  private openInEditor = (): void => {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: this.host?.placement === 'editor' ? 'popBack' : 'popOut',
      }),
    );
  };

  override render(): TemplateResult {
    const search = this.surface?.search ?? '';
    const inEditor = this.host?.placement === 'editor';
    return html`
      <div class="scrim" @click=${this.close}></div>
      <div class="panel" role="dialog" aria-label="Sessions">
        <div class="drawer-header">
          <span class="drawer-title">${this.host?.paper.name ?? ''}</span>
          ${renderIconActionButton({
            id: 'drawer-close',
            icon: 'xmark',
            label: 'Close',
            tooltip: 'Close',
            onClick: this.close,
          })}
        </div>
        <div class="drawer-search">
          <wa-input
            size="s"
            placeholder="Filter sessions"
            .value=${live(search)}
            @input=${this.handleSearchInput}
          >
            ${waIcon('magnifying-glass', { slot: 'start' })}
          </wa-input>
        </div>
        <div class="drawer-body">
          <stream-tabs
            sections
            .view=${this.view}
            .surface=${this.surface}
          ></stream-tabs>
        </div>
        <div class="drawer-footer">
          <wa-button
            appearance="plain"
            variant="neutral"
            size="s"
            type="button"
            @click=${this.openInEditor}
            >${waIcon(inEditor ? 'backward-step' : 'picture-in-picture', {
              slot: 'start',
            })}
            ${inEditor ? 'Back to sidebar' : 'Open sessions in editor'}</wa-button
          >
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-drawer': SessionDrawer;
  }
}
