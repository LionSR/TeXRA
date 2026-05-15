import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';
import { postMessage } from '@shared/hostBridge';
import { designTokens, commonViewStyles } from '@shared/styles';
import {
  formatOdysseyTime,
  isOdysseyInFlight,
  odysseyElapsedMs,
} from '@shared/schemas';
import type { Odyssey, OdysseyStatus } from '@shared/schemas';

import '@awesome.me/webawesome/dist/components/icon/icon.js';

function statusLabel(status: OdysseyStatus): string {
  return status[0].toUpperCase() + status.slice(1);
}

@customElement('odyssey-tab')
export class OdysseyTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .odyssey-list {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
      }

      .odyssey-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: var(--wa-space-s);
        align-items: center;
        padding: var(--wa-space-s);
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default);
      }

      .odyssey-row.is-clickable {
        cursor: pointer;
        transition: background-color 0.1s;
      }

      .odyssey-row.is-clickable:hover {
        background: var(--wa-color-surface-raised);
      }

      .status-chip {
        font-size: var(--wa-font-size-xs);
        font-weight: var(--wa-font-weight-semibold);
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--_chip-bg, var(--wa-color-neutral-fill-quiet));
        color: var(--_chip-fg, var(--wa-color-neutral-on-quiet));
      }

      .status-chip[data-status='active'] {
        --_chip-bg: var(--wa-color-success-fill-quiet);
        --_chip-fg: var(--wa-color-success-on-quiet);
      }

      .status-chip[data-status='paused'] {
        --_chip-bg: var(--wa-color-warning-fill-quiet);
        --_chip-fg: var(--wa-color-warning-on-quiet);
      }

      .status-chip[data-status='complete'] {
        --_chip-bg: var(--wa-color-brand-fill-quiet);
        --_chip-fg: var(--wa-color-brand-on-quiet);
      }

      .status-chip[data-status='abandoned'] {
        text-decoration: line-through;
      }

      .objective {
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-text-normal);
        line-height: 1.4;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .meta {
        display: flex;
        gap: var(--wa-space-s);
        font-size: var(--wa-font-size-xs);
        color: var(--wa-color-text-quiet);
        margin-top: 2px;
      }

      .stream-id {
        font-family: var(--wa-font-family-mono);
        font-size: var(--wa-font-size-xs);
        color: var(--wa-color-text-quiet);
      }

      .empty-state {
        padding: var(--wa-space-xl);
        text-align: center;
        color: var(--wa-color-text-quiet);
      }
    `,
  ];

  @property({ attribute: false }) items: readonly Odyssey[] = [];

  private handleRefresh = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.GET_ODYSSEY_LIST, {});
  };

  private handleReveal(streamId: string): void {
    postMessage(SETTINGS_VIEW_COMMANDS.REVEAL_ODYSSEY_STREAM, { streamId });
  }

  private handleRowKey(event: KeyboardEvent, streamId: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handleReveal(streamId);
    }
  }

  private renderReminder(): TemplateResult {
    return html`
      <div class="settings-reminder">
        <wa-icon
          library="texra"
          name="info"
          class="settings-reminder-icon"
        ></wa-icon>
        <div class="settings-reminder-body">
          <div class="settings-reminder-title">Odyssey (experimental)</div>
          <div class="settings-reminder-description">
            Odysseys are autonomous-continuation modes the assistant enters for
            itself when you describe a goal with a verifiable stopping
            condition. The agent decides when to start, pause, or complete an
            Odyssey via its tools — this list is for observation and navigation
            only.
          </div>
          <div class="settings-reminder-actions">
            <button class="tab-action-btn" @click=${this.handleRefresh}>
              <wa-icon library="texra" name="rotate-right"></wa-icon>
              Refresh
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderRow(item: Odyssey): TemplateResult {
    const inFlight = isOdysseyInFlight(item);
    return html`
      <div
        class=${'odyssey-row' + (inFlight ? ' is-clickable' : '')}
        @click=${inFlight ? () => this.handleReveal(item.streamId) : null}
        @keydown=${inFlight
          ? (e: KeyboardEvent) => this.handleRowKey(e, item.streamId)
          : null}
        role=${inFlight ? 'button' : 'group'}
        tabindex=${inFlight ? 0 : -1}
      >
        <span class="status-chip" data-status=${item.status}
          >${statusLabel(item.status)}</span
        >
        <div>
          <div class="objective" title=${item.objective}>${item.objective}</div>
          <div class="meta">
            <span class="stream-id">${item.streamId}</span>
            <span>· ${formatOdysseyTime(odysseyElapsedMs(item))} elapsed</span>
            ${item.continuationCount > 0
              ? html`<span>· ${item.continuationCount} continuations</span>`
              : nothing}
          </div>
        </div>
        ${inFlight
          ? html`<wa-icon library="texra" name="arrow-right"></wa-icon>`
          : nothing}
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tab-content-container">
        ${this.renderReminder()}
        ${this.items.length === 0
          ? html`<div class="empty-state">
              <wa-icon library="texra" name="compass"></wa-icon>
              <p>No Odysseys yet.</p>
            </div>`
          : html`
              <div class="odyssey-list">
                ${repeat(
                  this.items,
                  (it) => it.odysseyId,
                  (it) => this.renderRow(it),
                )}
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'odyssey-tab': OdysseyTab;
  }
}
