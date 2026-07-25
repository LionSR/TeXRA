/**
 * Collapsible panel for displaying background tasks (subagents and inquiries).
 *
 * Uses `<wa-details>` for the outer panel and for each nested section
 * (Processes, Subagents, Inquiries) and per-task output, for consistent
 * styling with other panels (Todos, Files, etc.) — the nested sections use the
 * `.collapsible-quiet` variant. Each subagent row is clickable to navigate to
 * its stream tab — finished ones included, their tab is still there. Processes
 * don't have their own tab so they are not clickable.
 *
 * Rows are live children followed by the finished children the backend retains
 * (`ActiveChildInfo.finishedAt`); this panel never counts what it cannot list.
 */

// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import {
  DEFAULT_STREAM_METADATA_STATUS,
  STREAM_PHASE,
  type ActiveChildInfo,
  type InquiryThreadUpdatedEvent,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { ProgressEvents } from '../events';

// Local imports - contexts
import {
  EMPTY_INQUIRY_THREADS,
  EMPTY_STREAM_BY_ID,
  inquiryThreadsContext,
  streamByIdContext,
  type StreamByIdMap,
} from '../contexts/streamContexts';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

@customElement('background-tasks-panel')
export class BackgroundTasksPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .task-list {
        display: flex;
        flex-direction: column;
      }

      /* The shared panel header already supplies the section boundary and
         lowered surface. Strip Web Awesome's surrounding card so expanding
         Background Tasks does not introduce a second white, rounded panel
         around the quiet child sections. */
      wa-details.panel-collapsible::part(base) {
        background: transparent;
        border: none;
        border-radius: 0;
      }

      .section-content {
        max-height: clamp(12rem, 42vh, 24rem);
        overflow-y: auto;
        scrollbar-gutter: stable;
      }

      .task-item {
        margin-bottom: 0;
      }

      .task-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-height: 1.5rem;
        padding: 1px 0;
        font-size: var(--font-size-sm);
        line-height: var(--line-height-tight);
      }

      .task-icon {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
      }

      .task-icon--process {
        color: var(--color-warning);
      }

      .task-icon--subagent {
        color: var(--color-info);
      }

      .task-icon--inquiry {
        color: var(--wa-color-brand-fill-loud);
      }

      .task-name {
        flex: 0 1 auto;
        max-width: min(14rem, 40%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--wa-color-text-normal);
      }

      .task-name--clickable {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: transparent;
        transition: text-decoration-color var(--transition-fast);
      }

      .task-name--clickable:hover {
        text-decoration-color: var(--wa-color-text-normal);
      }

      .task-description {
        flex: 1 1 8rem;
        min-width: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .task-elapsed {
        flex-shrink: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .inquiry-id {
        flex: 0 0 auto;
        font-family: var(--wa-font-family-code);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      /* Status uses a native wa-badge (filled), matching the app-wide badge
         idiom (GoalTab / WorktreeChip / StreamHeader goal chip) rather than a
         wa-tag — tags are for removable/category chips, badges for status. */
      wa-badge.task-status {
        flex: 0 0 auto;
        margin-left: auto;
      }

      wa-badge.task-status::part(base) {
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      /* Nested sections use Web Awesome <wa-details class="collapsible-quiet">
         in place of a hand-rolled <details>; the section label lives in the
         summary slot and keeps the uppercase small-caps look. wa-details
         supplies the disclosure chevron, so no hand-rolled toggle icon. */
      wa-details.collapsible-quiet::part(header) {
        padding-inline: 0;
      }

      .section-label {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: var(--letter-spacing-caps);
      }

      .section-label:hover {
        color: var(--wa-color-text-normal);
      }

      .section-label wa-icon {
        font-size: var(--font-size-xs);
      }
    `,
  ];

  /** Live children plus the finished ones retained for display (`finishedAt`). */
  @property({ attribute: false }) subagents: ActiveChildInfo[] = [];

  /** Open state — auto-expands when active tasks appear, auto-collapses when all finish. */
  @state() open = false;

  @consume({ context: streamByIdContext, subscribe: true })
  @state()
  private streamById: StreamByIdMap = EMPTY_STREAM_BY_ID;

  @consume({ context: inquiryThreadsContext, subscribe: true })
  @state()
  private inquiries: InquiryThreadUpdatedEvent[] = EMPTY_INQUIRY_THREADS;

  /** Track previous active count to detect transitions. */
  private prevActiveCount = 0;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const active =
      this.subagents.filter((child) => child.finishedAt === undefined).length +
      this.inquiries.filter((thread) => thread.status === 'open').length;
    // Auto-open when tasks appear (0 → N), auto-close when all finish (N → 0)
    if (this.prevActiveCount === 0 && active > 0) {
      this.open = true;
    } else if (this.prevActiveCount > 0 && active === 0) {
      this.open = false;
    }
    this.prevActiveCount = active;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.subagents.length + this.inquiries.length === 0) {
      return nothing;
    }

    return html`
      <wa-details
        class="panel-collapsible"
        summary="Background Tasks"
        ?open=${this.open}
        @wa-show=${this.handleShow}
        @wa-hide=${this.handleHide}
      >
        <div class="task-list">
          ${this.renderSection(this.subagents)} ${this.renderInquirySection()}
        </div>
      </wa-details>
    `;
  }

  private renderInquirySection(): TemplateResult | typeof nothing {
    if (this.inquiries.length === 0) return nothing;

    let openCount = 0;
    let answeredCount = 0;
    let droppedCount = 0;
    for (const t of this.inquiries) {
      if (t.status === 'open') openCount += 1;
      else if (t.status === 'answered') answeredCount += 1;
      else if (t.status === 'dropped') droppedCount += 1;
    }

    return html`
      <wa-details class="collapsible-quiet" open>
        <div slot="summary" class="section-label">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="comments"
            aria-hidden="true"
          ></wa-icon>
          <span
            >Inquiries${
              openCount ? html` &middot; ${openCount} open` : nothing
            }${
              answeredCount
                ? html` &middot; ${answeredCount} answered`
                : nothing
            }${
              droppedCount ? html` &middot; ${droppedCount} dropped` : nothing
            }</span
          >
        </div>
        <div class="section-content">
          ${repeat(
            this.inquiries,
            (thread) => thread.threadId,
            (thread, index) => this.renderInquiryItem(thread, index),
          )}
        </div>
      </wa-details>
    `;
  }

  private renderInquiryItem(
    thread: InquiryThreadUpdatedEvent,
    index: number,
  ): TemplateResult {
    const preview = thread.lastQuestionPreview || '(empty question)';
    const idPrefix = `background-inquiry-${index}`;
    return html`
      <div class="task-item">
        <div class="task-header">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="circle-question"
            aria-hidden="true"
            class="task-icon task-icon--inquiry"
          ></wa-icon>
          <span id="${idPrefix}-id" class="inquiry-id">${thread.threadId}</span>
          <wa-tooltip for="${idPrefix}-id">${thread.threadId}</wa-tooltip>
          <span id="${idPrefix}-description" class="task-description"
            >${preview}</span
          >
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
      </div>
    `;
  }

  private renderSection(
    children: ActiveChildInfo[],
  ): TemplateResult | typeof nothing {
    if (children.length === 0) return nothing;

    const activeCount = children.filter(
      (child) => child.finishedAt === undefined,
    ).length;
    const finishedCount = children.length - activeCount;

    return html`
      <wa-details class="collapsible-quiet">
        <div slot="summary" class="section-label">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="server-process"
            aria-hidden="true"
          ></wa-icon>
          <span
            >Subagents${
              activeCount ? html` &middot; ${activeCount} active` : nothing
            }${
              finishedCount ? html` &middot; ${finishedCount} done` : nothing
            }</span
          >
        </div>
        <div class="section-content">
          ${repeat(
            children,
            (c) => c.executionId,
            (c, index) => this.renderTaskItem(c, index),
          )}
        </div>
      </wa-details>
    `;
  }

  private renderTaskItem(
    child: ActiveChildInfo,
    index: number,
  ): TemplateResult {
    const icon = getTaskIcon(child);
    const childStreamId =
      child.kind === 'subagent' ? child.childStreamId : undefined;
    const isClickable = childStreamId !== undefined;
    const description = childStreamId
      ? this.streamById.get(childStreamId)?.description
      : undefined;
    const badge = taskStatusBadge(child);
    const idPrefix = `background-subagent-${index}`;
    const nameTooltip = isClickable
      ? `Go to ${child.agentName}`
      : child.agentName;

    return html`
      <div class="task-item">
        <div class="task-header">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name=${icon}
            aria-hidden="true"
            class=${classMap({
              'task-icon': true,
              'task-icon--process': !isAgentTool(child),
              'task-icon--subagent': isAgentTool(child),
            })}
          ></wa-icon>
          <span
            id="${idPrefix}-name"
            class=${classMap({
              'task-name': true,
              'task-name--clickable': isClickable,
            })}
            role=${isClickable ? 'link' : 'text'}
            tabindex=${isClickable ? '0' : '-1'}
            @click=${
              isClickable
                ? () => this.navigateToStream(childStreamId!)
                : nothing
            }
            @keydown=${
              isClickable
                ? (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      this.navigateToStream(childStreamId!);
                    }
                  }
                : nothing
            }
            >${child.agentName}</span
          >
          <wa-tooltip for="${idPrefix}-name">${nameTooltip}</wa-tooltip>
          ${
            description
              ? html`<span id="${idPrefix}-description" class="task-description"
                    >(${description})</span
                  ><wa-tooltip for="${idPrefix}-description"
                    >${description}</wa-tooltip
                  >`
              : nothing
          }
          ${
            child.elapsed
              ? html`<span class="task-elapsed">(${child.elapsed})</span>`
              : nothing
          }
          <wa-badge
            class="task-status"
            variant=${badge.variant}
            appearance="filled"
            >${badge.text}</wa-badge
          >
        </div>
      </div>
    `;
  }

  private handleShow(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = true;
  }

  private handleHide(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = false;
  }

  private navigateToStream(streamId: string): void {
    this.dispatchEvent(ProgressEvents.streamSwitch({ streamId }));
  }
}

/** True when the child is an AI agent (codex, delegation) rather than a plain shell tool. */
function isAgentTool(child: ActiveChildInfo): boolean {
  // Explicit tool name match, or subagent with no tool name (delegation/workflow)
  return (
    child.toolName === 'codex' || (!child.toolName && child.kind === 'subagent')
  );
}

/** Pick the appropriate wa-icon name for a background task item. */
function getTaskIcon(child: ActiveChildInfo): string {
  if (child.toolName === 'bash') return 'terminal';
  if (isAgentTool(child)) return 'robot';
  // Subagents (delegation, workflow) default to server-process;
  // processes without a toolName fall back to terminal.
  return child.kind === 'subagent' ? 'server-process' : 'terminal';
}

/**
 * Status badge for a background-task row. A retained subagent can briefly
 * keep its last in-flight phase while the terminal status catches up; show
 * that phase rather than falsely reporting success. Processes have no child
 * status source, so their retained rows use the terminal fallback below.
 */
function taskStatusBadge(child: ActiveChildInfo): {
  readonly text: string;
  readonly variant: 'neutral' | 'warning' | 'success' | 'danger';
} {
  const subagentStatusStillInFlight =
    child.kind === 'subagent' &&
    (child.status === STREAM_PHASE.RUNNING ||
      child.status === STREAM_PHASE.WAITING ||
      child.status === DEFAULT_STREAM_METADATA_STATUS);
  if (child.finishedAt === undefined || subagentStatusStillInFlight) {
    return child.status === STREAM_PHASE.WAITING ||
      child.status === DEFAULT_STREAM_METADATA_STATUS
      ? { text: 'waiting', variant: 'neutral' }
      : { text: 'running', variant: 'warning' };
  }
  switch (child.status) {
    case STREAM_PHASE.FAILED:
      return { text: STREAM_PHASE.FAILED, variant: 'danger' };
    case STREAM_PHASE.CANCELLED:
      return { text: STREAM_PHASE.CANCELLED, variant: 'neutral' };
    default:
      return { text: STREAM_PHASE.COMPLETED, variant: 'success' };
  }
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
