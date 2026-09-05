/**
 * The dispatch card (board E2): what a stream has fanned out, at the
 * dispatching row of its transcript. A `<wa-details>` headed "Dispatched N
 * subagents" with the parent's `rollup` as badges and "since <time>" from
 * the dispatching row, one row per child stream (nested children indented
 * under theirs), and a "Waiting on N subagents" line while any run. The
 * `inquiries` scope is the same card over the inquiry threads the stream
 * opened, in the conversation prelude. Every row is a child of the fold:
 * label, status, tone, latest line, and clock facts come from
 * `view.streams`; the host paints the glyph and the time. The card's open
 * state is the surface's (`Surface.groups`, key {@link DISPATCH_GROUP_KEY});
 * a toggle goes out as a `group` action. Selecting a row is the navigation.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA components used by this template
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports
import type { InquiryThreadUpdatedEvent, StreamTabId } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import {
  formatCompactDuration,
  formatResultCount,
} from '@utils/text/stringUtils';
import { getTimeFormatter } from '../formatters/timestampUtils';

/** The card's key in `Surface.groups` for its stream. */
export const DISPATCH_GROUP_KEY = 'dispatch';

/** Shape cue per tone (G4: the fold spells the tone, the host the glyph). */
const TONE_ICONS: Record<StreamView['tone'], TeXRAIconName> = {
  running: 'circle',
  success: 'circle-check',
  danger: 'circle-xmark',
  warning: 'circle-dot',
  neutral: 'circle',
};

@customElement('background-tasks-panel')
export class BackgroundTasksPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      wa-details.dispatch::part(base) {
        border-radius: var(--wa-border-radius-l);
      }
      wa-details.dispatch::part(header) {
        padding: var(--wa-space-xs) var(--wa-space-s);
      }
      wa-details.dispatch::part(content) {
        padding: 0 var(--wa-space-2xs) var(--wa-space-2xs);
      }

      .dispatch-summary {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-width: 0;
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
      }
      .dispatch-summary wa-icon {
        color: var(--wa-color-brand-on-quiet);
      }
      .dispatch-summary wa-badge::part(base) {
        font-size: 10px;
        line-height: 1;
        padding: 2px 6px;
      }
      .dispatch-since {
        font-weight: var(--font-weight-normal);
        font-variant-numeric: tabular-nums;
        color: var(--color-text-secondary);
      }

      .task-list {
        display: flex;
        flex-direction: column;
      }

      /* One row per child: the tone glyph, the label, the latest line, the
         clock, the chevron. Selecting the row opens the child. */
      .task-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        width: 100%;
        min-height: 1.75rem;
        padding: var(--wa-space-3xs) var(--wa-space-xs);
        border: 0;
        border-radius: var(--border-radius-small);
        background: transparent;
        font: inherit;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        text-align: start;
        cursor: pointer;
      }
      .task-row:hover {
        background: var(--wa-color-neutral-fill-quiet);
      }
      .task-row:focus-visible {
        outline: var(--focus-ring-width) solid var(--wa-color-focus);
        outline-offset: calc(-1 * var(--focus-ring-offset));
      }

      .task-icon {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
      }
      .tone-running .task-icon {
        color: var(--color-success);
      }
      .tone-success .task-icon {
        color: var(--color-success);
      }
      .tone-danger .task-icon {
        color: var(--color-error);
      }
      .tone-warning .task-icon {
        color: var(--color-warning);
      }
      .tone-neutral .task-icon {
        color: var(--color-text-muted);
      }

      .task-name {
        flex: 0 1 auto;
        min-width: 0;
        max-width: min(14rem, 45%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: var(--font-weight-medium);
      }

      .task-latest {
        flex: 1 1 8rem;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .task-elapsed {
        flex-shrink: 0;
        margin-inline-start: auto;
        font-size: var(--font-size-xs);
        font-variant-numeric: tabular-nums;
        color: var(--color-text-secondary);
      }
      .task-elapsed.is-approval {
        color: var(--color-warning);
      }

      .task-chevron {
        flex-shrink: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      :dir(rtl) .task-chevron {
        transform: scaleX(-1);
      }

      .task-wait {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) var(--wa-space-xs) 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .inquiry-id {
        flex: 0 0 auto;
        font-family: var(--wa-font-family-code);
        font-size: var(--font-size-xs);
        font-variant-numeric: tabular-nums;
        color: var(--color-text-secondary);
      }

      wa-badge.task-status {
        flex: 0 0 auto;
        margin-inline-start: auto;
      }
      wa-badge.task-status::part(base) {
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }
    `,
  ];

  /** The dispatching stream: its `childIds` are the rows. */
  @property({ attribute: false }) stream: StreamView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  /** The host's clock, for a running row's elapsed time (G4). */
  @property({ type: Number }) nowMs: number | null = null;

  /** The subagent rows at the dispatching row, or only the inquiry threads
   *  (the prelude of either stream kind). */
  @property() scope: 'dispatch' | 'inquiries' = 'dispatch';
  /** The dispatching row's timestamp: when the fan-out began. */
  @property({ type: Number }) since: number | null = null;
  /** `Surface.groups` for the dispatch key; a missing entry is open. */
  @property({ type: Boolean }) open = true;

  private childrenOf(stream: StreamView): StreamView[] {
    const view = this.view;
    if (!view) return [];
    return stream.childIds
      .map((id) => view.streams.get(id))
      .filter((child): child is StreamView => child !== undefined);
  }

  private inquiriesOf(stream: StreamView): InquiryThreadUpdatedEvent[] {
    return (this.view?.inquiries ?? []).filter(
      (thread) => thread.parentStreamId === stream.id,
    );
  }

  override render(): TemplateResult | typeof nothing {
    const stream = this.stream;
    if (!stream) return nothing;
    return this.scope === 'inquiries'
      ? this.renderInquiries(stream)
      : this.renderDispatch(stream);
  }

  private renderDispatch(stream: StreamView): TemplateResult | typeof nothing {
    const children = this.childrenOf(stream);
    if (children.length === 0) return nothing;
    const { rollup } = stream;
    return html`
      <wa-details
        class="dispatch"
        ?open=${this.open}
        @wa-show=${this.handleToggle}
        @wa-hide=${this.handleToggle}
      >
        <span slot="summary" class="dispatch-summary"
          >${waIcon('diagram-project')} Dispatched
          ${formatResultCount(rollup.total, BACKGROUND_TASK.countNoun)}
          <wa-badge variant="neutral" appearance="outlined" pill
            >${rollup.total}</wa-badge
          >${
            rollup.running > 0
              ? html`<wa-badge variant="success" pill
                  >${rollup.running}</wa-badge
                >`
              : nothing
          }${
            stream.approval === 'descendant'
              ? html`<wa-badge variant="warning" pill
                  >${waIcon('triangle-exclamation')}</wa-badge
                >`
              : nothing
          }${
            this.since === null
              ? nothing
              : html`<span class="dispatch-since"
                  >since
                  ${getTimeFormatter().format(new Date(this.since))}</span
                >`
          }</span
        >
        <div class="task-list" role="list">
          ${this.renderChildren(children, 0)}
        </div>
        ${
          rollup.running > 0
            ? html`<div class="task-wait">
                ${waIcon('clock')} Waiting on
                ${formatResultCount(rollup.running, BACKGROUND_TASK.countNoun)}
              </div>`
            : nothing
        }
      </wa-details>
    `;
  }

  private renderInquiries(stream: StreamView): TemplateResult | typeof nothing {
    const inquiries = this.inquiriesOf(stream);
    if (inquiries.length === 0) return nothing;
    return html`
      <wa-details class="dispatch" open>
        <span slot="summary" class="dispatch-summary"
          >${waIcon('comments')} Inquiries
          <wa-badge variant="neutral" appearance="outlined" pill
            >${inquiries.length}</wa-badge
          ></span
        >
        <div class="task-list" role="list">
          ${repeat(
            inquiries,
            (thread) => thread.threadId,
            (thread, index) => this.renderInquiryItem(thread, index),
          )}
        </div>
      </wa-details>
    `;
  }

  private handleToggle(event: Event): void {
    if (event.target !== event.currentTarget || !this.stream) return;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'group',
        streamId: this.stream.id,
        key: DISPATCH_GROUP_KEY,
        expanded: event.type === 'wa-show',
      }),
    );
  }

  private renderChildren(
    children: readonly StreamView[],
    depth: number,
  ): TemplateResult {
    return html`${repeat(
      children,
      (child) => child.id,
      (child) =>
        html`${this.renderChildRow(child, depth)}${this.renderChildren(
          this.childrenOf(child),
          depth + 1,
        )}`,
    )}`;
  }

  private renderChildRow(child: StreamView, depth: number): TemplateResult {
    const pendingApproval = child.approval === 'own';
    const glyph = pendingApproval ? 'circle-dot' : TONE_ICONS[child.tone];
    const latest = child.latestLine ?? child.description ?? '';
    const label = `Open ${child.label}: ${child.statusLabel}`;
    return html`
      <button
        type="button"
        role="listitem"
        class=${classMap({
          'task-row': true,
          [`tone-${pendingApproval ? 'warning' : child.tone}`]: true,
        })}
        style=${`padding-inline-start: calc(var(--wa-space-xs) + ${depth} * var(--wa-space-m))`}
        aria-label=${label}
        @click=${() => this.navigateToStream(child.id)}
      >
        ${waIcon(glyph, { className: 'task-icon' })}
        <span class="task-name">${child.label}</span>
        ${latest ? html`<span class="task-latest">${latest}</span>` : nothing}
        ${renderClock(child, pendingApproval, this.nowMs)}
        ${waIcon('chevron-right', { className: 'task-chevron' })}
      </button>
    `;
  }

  private renderInquiryItem(
    thread: InquiryThreadUpdatedEvent,
    index: number,
  ): TemplateResult {
    const preview = thread.lastQuestionPreview || '(empty question)';
    const idPrefix = `background-inquiry-${index}`;
    return html`
      <div class="task-row" role="listitem">
        ${waIcon('circle-question', { className: 'task-icon' })}
        <span class="inquiry-id">${thread.threadId}</span>
        <span id="${idPrefix}-description" class="task-latest">${preview}</span>
        <wa-tooltip for="${idPrefix}-description">${preview}</wa-tooltip>
        <wa-relative-time
          id="${idPrefix}-elapsed"
          class="task-elapsed"
          date=${thread.lastActivityIso}
          format="narrow"
          sync
        ></wa-relative-time>
        <wa-tooltip for="${idPrefix}-elapsed"
          >${thread.lastActivityIso}</wa-tooltip
        >
        <wa-badge
          class="task-status"
          variant=${inquiryStatusVariant(thread.status)}
          appearance="filled"
          >${thread.status}</wa-badge
        >
      </div>
    `;
  }

  private navigateToStream(streamId: StreamTabId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', streamId }));
  }
}

/**
 * The row's clock: "approval" while the child waits on the user, the live
 * elapsed while it runs (the host ticks), else when it was last active.
 */
function renderClock(
  child: StreamView,
  pendingApproval: boolean,
  nowMs: number | null,
): TemplateResult | typeof nothing {
  if (pendingApproval) {
    return html`<span class="task-elapsed is-approval">approval</span>`;
  }
  const running = child.group === 'running' || child.group === 'waiting';
  if (running && child.runStartedAt !== null && nowMs !== null) {
    return html`<span class="task-elapsed"
      >${formatCompactDuration(nowMs - child.runStartedAt)}</span
    >`;
  }
  if (child.lastTimestamp !== null) {
    return html`<wa-relative-time
      class="task-elapsed"
      .date=${new Date(child.lastTimestamp)}
      format="narrow"
      sync
    ></wa-relative-time>`;
  }
  return nothing;
}

function inquiryStatusVariant(
  status: InquiryThreadUpdatedEvent['status'],
): 'warning' | 'success' | 'neutral' {
  if (status === 'open') return 'warning';
  if (status === 'answered') return 'success';
  return 'neutral';
}

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
