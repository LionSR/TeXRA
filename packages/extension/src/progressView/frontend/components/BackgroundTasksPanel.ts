/**
 * Collapsible panel for displaying background tasks (processes and subagents).
 *
 * Uses `<wa-details>` for the outer panel and for each nested section
 * (Processes, Subagents, Inquiries) and per-task output, for consistent
 * styling with other panels (Todos, Files, etc.) — the nested sections use the
 * `.collapsible-quiet` variant. Each active subagent is clickable to navigate
 * to its stream tab. Processes don't have their own tab so they are not
 * clickable.
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
  processOutputContext,
  streamByIdContext,
  type StreamByIdMap,
} from '../contexts/streamContexts';
import { EMPTY_PROCESS_OUTPUTS, type ProcessOutputMap } from '../store';

// Side-effect imports - sibling components
import './TerminalOutput';

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

      .empty-message {
        padding: var(--wa-space-2xs) 0;
      }

      /* Collapsible output per task — also a <wa-details>. */
      wa-details.task-output {
        margin-left: calc(var(--wa-space-2xs) + var(--font-size-sm));
      }

      wa-details.task-output::part(header) {
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .output-container {
        margin-top: var(--wa-space-3xs);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius-small);
        overflow: hidden;
      }
    `,
  ];

  @property({ attribute: false }) activeProcesses: ActiveChildInfo[] = [];
  @property({ attribute: false }) finishedProcessCount = 0;
  @property({ attribute: false }) activeSubagents: ActiveChildInfo[] = [];
  @property({ attribute: false }) finishedSubagentCount = 0;

  /** Open state — auto-expands when active tasks appear, auto-collapses when all finish. */
  @state() open = false;

  @consume({ context: processOutputContext, subscribe: true })
  @state()
  private processOutputs: ProcessOutputMap = EMPTY_PROCESS_OUTPUTS;

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
      this.activeProcesses.length +
      this.activeSubagents.length +
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
    const active = this.activeProcesses.length + this.activeSubagents.length;
    const finished = this.finishedProcessCount + this.finishedSubagentCount;
    if (active + finished + this.inquiries.length === 0) return nothing;

    return html`
      <wa-details
        class="panel-collapsible"
        summary="Background Tasks"
        ?open=${this.open}
        @wa-show=${this.handleShow}
        @wa-hide=${this.handleHide}
      >
        <div class="task-list">
          ${this.renderSection(
            this.activeProcesses,
            this.finishedProcessCount,
            'process',
          )}
          ${this.renderSection(
            this.activeSubagents,
            this.finishedSubagentCount,
            'subagent',
          )}
          ${this.renderInquirySection()}
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
            (thread) => this.renderInquiryItem(thread),
          )}
        </div>
      </wa-details>
    `;
  }

  private renderInquiryItem(thread: InquiryThreadUpdatedEvent): TemplateResult {
    const preview = thread.lastQuestionPreview || '(empty question)';
    return html`
      <div class="task-item">
        <div class="task-header">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name="circle-question"
            aria-hidden="true"
            class="task-icon task-icon--inquiry"
          ></wa-icon>
          <span class="inquiry-id" title=${thread.threadId}
            >${thread.threadId}</span
          >
          <span class="task-description" title=${preview}>${preview}</span>
          <wa-relative-time
            class="task-elapsed"
            date=${thread.lastActivityIso}
            title=${thread.lastActivityIso}
            format="narrow"
            sync
          ></wa-relative-time>
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
    active: ActiveChildInfo[],
    finishedCount: number,
    kind: 'process' | 'subagent',
  ): TemplateResult | typeof nothing {
    const hasActive = active.length > 0;
    const hasFinished = finishedCount > 0;
    if (!hasActive && !hasFinished) return nothing;

    const icon = kind === 'process' ? 'terminal' : 'server-process';
    const label = kind === 'process' ? 'Processes' : 'Subagents';

    return html`
      <wa-details class="collapsible-quiet">
        <div slot="summary" class="section-label">
          <wa-icon
            library=${TEXRA_ICON_LIBRARY}
            name=${icon}
            aria-hidden="true"
          ></wa-icon>
          <span
            >${label}${
              hasActive ? html` &middot; ${active.length} active` : nothing
            }${
              hasFinished ? html` &middot; ${finishedCount} done` : nothing
            }</span
          >
        </div>
        <div class="section-content">
          ${
            hasActive
              ? repeat(
                  active,
                  (c) => c.executionId,
                  (c) => this.renderTaskItem(c),
                )
              : nothing
          }
          ${
            !hasActive && hasFinished
              ? html`<div class="empty-message">
                  <em class="text-secondary"
                    >All ${finishedCount} ${label.toLowerCase()} completed</em
                  >
                </div>`
              : nothing
          }
        </div>
      </wa-details>
    `;
  }

  private renderTaskItem(child: ActiveChildInfo): TemplateResult {
    const icon = getTaskIcon(child);
    const entry = this.processOutputs.get(child.executionId);
    const childStreamId =
      child.kind === 'subagent' ? child.childStreamId : undefined;
    const isClickable = childStreamId !== undefined;
    const description = childStreamId
      ? this.streamById.get(childStreamId)?.description
      : undefined;
    const waiting = isWaiting(child);

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
            class=${classMap({
              'task-name': true,
              'task-name--clickable': isClickable,
            })}
            title=${isClickable ? `Go to ${child.agentName}` : child.agentName}
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
          ${
            description
              ? html`<span class="task-description" title=${description}
                  >(${description})</span
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
            variant=${waiting ? 'neutral' : 'warning'}
            appearance="filled"
            >${waiting ? 'waiting' : 'running'}</wa-badge
          >
        </div>
        ${
          entry?.stdout
            ? this.renderOutputStream('stdout', entry.stdout)
            : nothing
        }
        ${
          entry?.stderr
            ? this.renderOutputStream('stderr', entry.stderr)
            : nothing
        }
      </div>
    `;
  }

  private renderOutputStream(label: string, text: string): TemplateResult {
    return html`
      <wa-details class="collapsible-quiet task-output" open>
        <span slot="summary">${label}</span>
        <div class="output-container">
          <terminal-output .text=${text}></terminal-output>
        </div>
      </wa-details>
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

/** Check if a child is in a waiting/idle state rather than actively processing. */
function isWaiting(child: ActiveChildInfo): boolean {
  return (
    child.status === STREAM_PHASE.WAITING ||
    child.status === DEFAULT_STREAM_METADATA_STATUS
  );
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
