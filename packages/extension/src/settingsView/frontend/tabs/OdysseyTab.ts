import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { designTokens, commonViewStyles } from '@shared/styles';
import {
  formatOdysseyTime,
  isOdysseyInFlight,
  odysseyDurationMs,
} from '@shared/schemas';
import type { Odyssey, OdysseyStatus } from '@shared/schemas';
import { metaStripStyles, renderDotMeta } from '@shared/wa/metaStrip';
import type { MetaPart } from '@shared/wa/metaStrip';

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';

function statusLabel(status: OdysseyStatus): string {
  return status[0].toUpperCase() + status.slice(1);
}

/** Map an Odyssey status to a wa-badge variant. */
function statusVariant(
  status: OdysseyStatus,
): 'brand' | 'neutral' | 'success' | 'warning' {
  switch (status) {
    case 'active':
      return 'success';
    case 'paused':
      return 'warning';
    case 'complete':
      return 'brand';
    default:
      return 'neutral';
  }
}

@customElement('odyssey-tab')
export class OdysseyTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    metaStripStyles,
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

      /* Native wa-badge (variant per status, quiet 'filled' appearance),
         compacted to the prior 2px chip padding. */
      .status-chip::part(base) {
        padding: 2px var(--wa-space-2xs);
        font-weight: var(--wa-font-weight-semibold);
      }

      .status-chip[data-status='abandoned']::part(base) {
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
          <div class="settings-reminder-title">Odyssey</div>
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
    const metaParts: MetaPart[] = [
      html`<span class="stream-id">${item.streamId}</span>`,
      html`<span
        title="Wall-clock duration from Odyssey start to now while it is active, or to when it was last touched"
        >duration ${formatOdysseyTime(odysseyDurationMs(item))}</span
      >`,
    ];
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
        <wa-badge
          class="status-chip"
          variant=${statusVariant(item.status)}
          appearance="filled"
          data-status=${item.status}
          >${statusLabel(item.status)}</wa-badge
        >
        <div>
          <div class="objective" title=${item.objective}>${item.objective}</div>
          <div class="text-secondary meta-strip">
            ${renderDotMeta(metaParts)}
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
