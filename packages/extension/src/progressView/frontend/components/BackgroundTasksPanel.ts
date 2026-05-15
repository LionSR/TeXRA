/**
 * Collapsible panel for displaying background tasks (processes and subagents).
 *
 * Uses `<wa-details>` for consistent styling with other panels (Todos,
 * Files, etc.). Each active subagent is clickable to navigate to its stream tab.
 * Processes don't have their own tab so they are not clickable.
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

// Local imports
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { STREAM_STATUS, type ActiveChildInfo } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { ProgressEvents } from '../events';

// Local imports - contexts
import {
  EMPTY_PROCESS_OUTPUTS,
  EMPTY_STREAM_BY_ID,
  processOutputContext,
  streamByIdContext,
  type ProcessOutputMap,
  type StreamByIdMap,
} from '../contexts/streamContexts';

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

      wa-tag.task-status {
        flex: 0 0 auto;
        margin-left: auto;
      }

      wa-tag.task-status::part(base) {
        min-height: 1.25rem;
        padding: 0 var(--wa-space-xs);
        font-size: var(--font-size-xs);
        line-height: 1;
      }

      .section-label {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) 0 var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: pointer;
        list-style: none;
        user-select: none;
      }

      .section-label::-webkit-details-marker {
        display: none;
      }

      .section-label:hover {
        color: var(--wa-color-text-normal);
      }

      .section-label wa-icon {
        font-size: var(--font-size-xs);
      }

      .empty-message {
        padding: var(--wa-space-2xs) 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        font-style: italic;
      }

      /* Collapsible output per task */
      details.task-output {
        margin-left: calc(var(--wa-space-2xs) + var(--font-size-sm));
      }

      details.task-output > summary {
        padding: var(--wa-space-3xs) 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        cursor: pointer;
        list-style: none;
        user-select: none;
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

  /** Track previous active count to detect transitions. */
  private prevActiveCount = 0;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const active = this.activeProcesses.length + this.activeSubagents.length;
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
    if (active + finished === 0) return nothing;

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
        </div>
      </wa-details>
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
      <details>
        <summary class="section-label">
          <wa-icon
            library="texra"
            name="chevron-right"
            class="toggle-icon"
            aria-hidden="true"
          ></wa-icon>
          <wa-icon library="texra" name=${icon} aria-hidden="true"></wa-icon>
          <span
            >${label}${hasActive
              ? html` &middot; ${active.length} active`
              : nothing}${hasFinished
              ? html` &middot; ${finishedCount} done`
              : nothing}</span
          >
        </summary>
        <div class="section-content">
          ${hasActive
            ? repeat(
                active,
                (c) => c.executionId,
                (c) => this.renderTaskItem(c, kind),
              )
            : nothing}
          ${!hasActive && hasFinished
            ? html`<div class="empty-message">
                All ${finishedCount} ${label.toLowerCase()} completed
              </div>`
            : nothing}
        </div>
      </details>
    `;
  }

  private renderTaskItem(
    child: ActiveChildInfo,
    kind: 'process' | 'subagent',
  ): TemplateResult {
    const icon = getTaskIcon(child);
    const entry = this.processOutputs.get(child.executionId);
    const isClickable = Boolean(child.childStreamId);
    const description = child.childStreamId
      ? this.streamById.get(child.childStreamId)?.description
      : undefined;
    const waiting = isWaiting(child);

    return html`
      <div class="task-item">
        <div class="task-header">
          <wa-icon
            library="texra"
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
            @click=${isClickable
              ? () => this.navigateToStream(child.childStreamId!)
              : nothing}
            @keydown=${isClickable
              ? (e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.navigateToStream(child.childStreamId!);
                  }
                }
              : nothing}
            >${child.agentName}</span
          >
          ${description
            ? html`<span class="task-description" title=${description}
                >(${description})</span
              >`
            : nothing}
          ${child.elapsed
            ? html`<span class="task-elapsed">(${child.elapsed})</span>`
            : nothing}
          <wa-tag
            class="task-status"
            variant=${waiting ? 'neutral' : 'warning'}
            size="small"
            >${waiting ? 'waiting' : 'running'}</wa-tag
          >
        </div>
        ${entry?.stdout
          ? this.renderOutputStream('stdout', entry.stdout)
          : nothing}
        ${entry?.stderr
          ? this.renderOutputStream('stderr', entry.stderr)
          : nothing}
      </div>
    `;
  }

  private renderOutputStream(label: string, text: string): TemplateResult {
    return html`
      <details class="task-output" open>
        <summary>
          <wa-icon
            library="texra"
            name="chevron-right"
            class="toggle-icon"
            aria-hidden="true"
          ></wa-icon>
          ${label}
        </summary>
        <div class="output-container">
          <terminal-output .text=${text}></terminal-output>
        </div>
      </details>
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
    child.toolName === 'codex' ||
    (!child.toolName && Boolean(child.childStreamId))
  );
}

/** Pick the appropriate wa-icon name for a background task item. */
function getTaskIcon(child: ActiveChildInfo): string {
  if (child.toolName === 'bash') return 'terminal';
  if (isAgentTool(child)) return 'robot';
  // Subagents (delegation, workflow) default to server-process;
  // processes without a toolName fall back to terminal.
  return child.childStreamId ? 'server-process' : 'terminal';
}

/** Check if a child is in a waiting/idle state rather than actively processing. */
function isWaiting(child: ActiveChildInfo): boolean {
  return (
    child.status === STREAM_STATUS.WAITING ||
    child.status === STREAM_STATUS.READY
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
