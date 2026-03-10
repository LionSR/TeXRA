/**
 * Collapsible panel for displaying background tasks (processes and subagents).
 *
 * Uses `<vscode-collapsible>` for consistent styling with other panels (Todos,
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

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';

// Local imports - types
import { STREAM_STATUS, type ActiveChildInfo } from '@shared/schemas';

// Local imports - events
import { ProgressEvents } from '../events';

// Local imports - contexts
import {
  EMPTY_PROCESS_OUTPUTS,
  processOutputContext,
  type ProcessOutputMap,
} from '../contexts/streamContexts';

// Side-effect imports - sibling components
import './TerminalOutput';

@customElement('background-tasks-panel')
export class BackgroundTasksPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
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
        gap: var(--spacing-tiny);
      }

      .task-item {
        margin-bottom: var(--spacing-tiny);
      }

      .task-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        font-size: var(--font-size-sm);
      }

      .task-icon {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
      }

      .task-icon--process {
        color: var(--color-warning, var(--vscode-charts-orange));
      }

      .task-icon--subagent {
        color: var(--color-info, var(--vscode-charts-blue));
      }

      .task-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--vscode-foreground);
      }

      .task-name--clickable {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: transparent;
        transition: text-decoration-color 0.15s ease;
      }

      .task-name--clickable:hover {
        text-decoration-color: var(--vscode-foreground);
      }

      .task-status {
        flex-shrink: 0;
        font-size: var(--font-size-xs, 10px);
        padding: 1px var(--spacing-small);
        border-radius: var(--border-radius-small);
        color: var(--_tint);
        background: color-mix(in srgb, var(--_tint) 12%, transparent);
      }

      .task-status--running {
        --_tint: var(--color-warning, var(--vscode-charts-orange));
      }

      .task-status--waiting {
        --_tint: var(--color-text-secondary);
      }

      .section-label {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-small) 0 var(--spacing-tiny);
        font-size: var(--font-size-xs, 10px);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .section-label .codicon {
        font-size: var(--font-size-xs, 10px);
      }

      .empty-message {
        padding: var(--spacing-small) 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        font-style: italic;
      }

      /* Collapsible output per task */
      details.task-output {
        margin-left: calc(var(--spacing-small) + var(--font-size-sm));
      }

      details.task-output > summary {
        padding: 2px 0;
        font-size: var(--font-size-xs, 10px);
        color: var(--color-text-secondary);
        cursor: pointer;
        list-style: none;
        user-select: none;
      }

      details.task-output > summary:hover {
        color: var(--vscode-foreground);
      }

      .output-container {
        margin-top: var(--spacing-tiny);
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

  /** Open state — managed internally. Toggled by user or auto-opened on first active task. */
  @state() open = false;

  @consume({ context: processOutputContext, subscribe: true })
  @state()
  private processOutputs: ProcessOutputMap = EMPTY_PROCESS_OUTPUTS;

  /** Track previous active count to detect 0→N transitions for auto-open. */
  private prevActiveCount = 0;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const active = this.activeProcesses.length + this.activeSubagents.length;
    // Auto-open when tasks first appear (0 → N), but never force-close
    if (this.prevActiveCount === 0 && active > 0) {
      this.open = true;
    }
    this.prevActiveCount = active;
  }

  override render(): TemplateResult | typeof nothing {
    const active =
      this.activeProcesses.length + this.activeSubagents.length;
    const finished = this.finishedProcessCount + this.finishedSubagentCount;
    if (active + finished === 0) return nothing;

    const title = this.buildTitle(finished);

    return html`
      <vscode-collapsible
        class="panel-collapsible"
        title=${title}
        ?open=${this.open}
        @vsc-collapsible-toggle=${this.handleCollapsibleToggle}
      >
        <div class="task-list">
          ${this.renderSection(this.activeProcesses, this.finishedProcessCount, 'process')}
          ${this.renderSection(this.activeSubagents, this.finishedSubagentCount, 'subagent')}
        </div>
      </vscode-collapsible>
    `;
  }

  private buildTitle(finished: number): string {
    const all = [...this.activeProcesses, ...this.activeSubagents];
    const running = all.filter((c) => !isWaiting(c)).length;
    const waiting = all.filter((c) => isWaiting(c)).length;

    const segments: string[] = [];
    if (running > 0) segments.push(`${running} running`);
    if (waiting > 0) segments.push(`${waiting} waiting`);
    if (finished > 0) segments.push(`${finished} done`);
    return segments.length > 0
      ? `Background Tasks (${segments.join(', ')})`
      : 'Background Tasks';
  }

  private renderSection(
    active: ActiveChildInfo[],
    finishedCount: number,
    kind: 'process' | 'subagent',
  ): TemplateResult | typeof nothing {
    const hasActive = active.length > 0;
    const hasFinished = finishedCount > 0;
    if (!hasActive && !hasFinished) return nothing;

    const icon =
      kind === 'process' ? 'codicon-terminal' : 'codicon-server-process';
    const label = kind === 'process' ? 'Processes' : 'Subagents';

    return html`
      <div class="section-label">
        <i class="codicon ${icon}"></i>
        <span
          >${label}${hasActive
            ? html` &middot; ${active.length} active`
            : nothing}${hasFinished
            ? html` &middot; ${finishedCount} done`
            : nothing}</span
        >
      </div>
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
    `;
  }

  private renderTaskItem(
    child: ActiveChildInfo,
    kind: 'process' | 'subagent',
  ): TemplateResult {
    const icon =
      kind === 'process' ? 'codicon-terminal' : 'codicon-server-process';
    const entry = this.processOutputs.get(child.executionId);
    const hasStdout = Boolean(entry?.stdout);
    const hasStderr = Boolean(entry?.stderr);
    const isClickable = kind === 'subagent' && Boolean(child.childStreamId);

    return html`
      <div class="task-item">
        <div class="task-header">
          <i
            class=${classMap({
              codicon: true,
              [icon]: true,
              'task-icon': true,
              'task-icon--process': kind === 'process',
              'task-icon--subagent': kind === 'subagent',
            })}
          ></i>
          <span
            class=${classMap({
              'task-name': true,
              'task-name--clickable': isClickable,
            })}
            title=${isClickable
              ? `Go to ${child.agentName}`
              : child.agentName}
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
          <span
            class=${classMap({
              'task-status': true,
              'task-status--running': !isWaiting(child),
              'task-status--waiting': isWaiting(child),
            })}
            >${isWaiting(child) ? 'waiting' : 'running'}</span
          >
        </div>
        ${hasStdout
          ? this.renderOutputStream('stdout', entry!.stdout)
          : nothing}
        ${hasStderr
          ? this.renderOutputStream('stderr', entry!.stderr)
          : nothing}
      </div>
    `;
  }

  private renderOutputStream(
    label: string,
    text: string,
  ): TemplateResult {
    return html`
      <details class="task-output" open>
        <summary>
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          ${label}
        </summary>
        <div class="output-container">
          <terminal-output .text=${text}></terminal-output>
        </div>
      </details>
    `;
  }

  private handleCollapsibleToggle(e: CustomEvent<{ open?: boolean }>): void {
    this.open = e.detail?.open ?? this.open;
  }

  private navigateToStream(streamId: string): void {
    this.dispatchEvent(ProgressEvents.streamSwitch({ streamId }));
  }
}

/** Toggle open state and scroll into view. Shared by ToolUseStreamContent and WorkflowStreamContent. */
export function toggleBackgroundTasksPanel(
  panelRef: { value: BackgroundTasksPanel | undefined },
): void {
  const panel = panelRef.value;
  if (!panel) return;
  panel.open = !panel.open;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Check if a child is in a waiting/idle state rather than actively processing. */
function isWaiting(child: ActiveChildInfo): boolean {
  return child.status === STREAM_STATUS.WAITING || child.status === STREAM_STATUS.READY;
}

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
