import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { designTokens, commonViewStyles } from '@shared/styles';
import { formatGoalTime, isGoalInFlight, goalElapsedMs } from '@shared/schemas';
import type { Goal } from '@shared/schemas';
import { metaStripStyles, renderDotMeta } from '@shared/wa/metaStrip';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import type { MetaPart } from '@shared/wa/metaStrip';
import { capitalize } from '@utils/text/stringUtils';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';

@customElement('goal-tab')
export class GoalTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    metaStripStyles,
    css`
      :host {
        display: block;
      }

      .goal-list {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
      }

      .goal-actions {
        display: flex;
        justify-content: flex-end;
        margin-bottom: var(--wa-space-xs);
      }

      .goal-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: var(--wa-space-s);
        align-items: center;
        padding: var(--wa-space-s);
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default);
      }

      .goal-row.is-clickable {
        cursor: pointer;
        transition: background-color 0.1s;
      }

      .goal-row.is-clickable:hover {
        background: var(--wa-color-surface-raised);
      }

      /* Native wa-badge (variant per status, quiet 'filled' appearance),
         compacted to the prior 2px chip padding. */
      .status-chip::part(base) {
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-weight: var(--wa-font-weight-semibold);
      }

      .objective {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        line-height: 1.4;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .stream-id {
        font-family: var(--wa-font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--wa-color-text-quiet);
      }
    `,
  ];

  @property({ attribute: false }) items: readonly Goal[] = [];

  private handleRefresh = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST, {});
  };

  private handleReveal(streamId: string): void {
    postMessage(SETTINGS_VIEW_COMMANDS.REVEAL_GOAL_STREAM, { streamId });
  }

  private handleRowKey(event: KeyboardEvent, streamId: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handleReveal(streamId);
    }
  }

  private renderActions(): TemplateResult {
    return html`<div class="goal-actions">
      ${renderLabeledActionButton({
        icon: 'rotate-right',
        text: 'Refresh',
        kind: 'secondary',
        appearance: 'outlined',
        onClick: this.handleRefresh,
      })}
    </div>`;
  }

  private renderRow(item: Goal): TemplateResult {
    const inFlight = isGoalInFlight(item);
    const metaParts: MetaPart[] = [
      html`<span class="stream-id">${item.streamId}</span>`,
      html`<span title="Wall-clock duration since this Goal started"
        >duration ${formatGoalTime(goalElapsedMs(item))}</span
      >`,
    ];
    return html`
      <div
        class=${`goal-row${inFlight ? ' is-clickable' : ''}`}
        @click=${inFlight ? () => this.handleReveal(item.streamId) : null}
        @keydown=${
          inFlight
            ? (e: KeyboardEvent) => this.handleRowKey(e, item.streamId)
            : null
        }
        role=${inFlight ? 'button' : 'group'}
        tabindex=${inFlight ? 0 : -1}
      >
        <wa-badge
          class="status-chip"
          variant=${item.status === 'active' ? 'success' : 'warning'}
          appearance="filled"
          >${capitalize(item.status)}</wa-badge
        >
        <div>
          <div class="objective" title=${item.objective}>${item.objective}</div>
          <div class="text-secondary meta-strip">
            ${renderDotMeta(metaParts)}
          </div>
        </div>
        ${inFlight ? waIcon('chevron-right') : nothing}
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tab-content-container">
        ${this.renderActions()}
        ${
          this.items.length === 0
            ? renderEmptyState({
                icon: 'compass',
                title: 'No goals yet',
                body: 'Approve a plan with "Run as Goal" to start one.',
                headingTag: 'h3',
                className: 'empty-state',
              })
            : html`
                <div class="goal-list">
                  ${repeat(
                    this.items,
                    (it) => it.goalId,
                    (it) => this.renderRow(it),
                  )}
                </div>
              `
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'goal-tab': GoalTab;
  }
}
