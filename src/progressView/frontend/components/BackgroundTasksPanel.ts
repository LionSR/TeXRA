/**
 * Collapsible panel for displaying background tasks (processes and subagents).
 *
 * Shows a summary badge in the collapsed header and a list of active/finished
 * tasks when expanded. Each active task has a collapsible real-time terminal
 * output section powered by the existing TerminalOutput (xterm.js) component.
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
import type { ActiveChildInfo } from '@shared/schemas';

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

      details.panel-root {
        border-top: var(--border-thin) solid var(--color-border);
      }

      summary {
        padding: var(--spacing-small) var(--spacing-medium);
      }

      .panel-title {
        font-weight: var(--font-weight-medium);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .badge-count {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        margin-left: var(--spacing-small);
        padding: 1px var(--spacing-small);
        font-size: var(--font-size-xs, 10px);
        font-weight: var(--font-weight-semibold);
        border-radius: var(--border-radius-small);
        white-space: nowrap;
        color: var(--_tint);
        background: color-mix(in srgb, var(--_tint) 12%, transparent);
      }

      .badge-count--active {
        --_tint: var(--color-warning, var(--vscode-charts-orange));
      }

      .badge-count--done {
        --_tint: var(--color-text-secondary);
      }

      .task-list {
        list-style: none;
        margin: 0;
        padding: 0 var(--spacing-medium) var(--spacing-small);
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

      .task-status {
        --_tint: var(--color-warning, var(--vscode-charts-orange));
        flex-shrink: 0;
        font-size: var(--font-size-xs, 10px);
        padding: 1px var(--spacing-small);
        border-radius: var(--border-radius-small);
        color: var(--_tint);
        background: color-mix(in srgb, var(--_tint) 12%, transparent);
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

    return html`
      <details class="panel-root" ?open=${this.open} @toggle=${this.handleToggle}>
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-terminal panel-icon"></i>
          <span class="panel-title">Background Tasks</span>
          ${active > 0
            ? html`<span class="badge-count badge-count--active"
                >${active} running</span
              >`
            : nothing}
          ${finished > 0
            ? html`<span class="badge-count badge-count--done"
                >${finished} done</span
              >`
            : nothing}
        </summary>
        <div class="task-list">
          ${this.renderSection(this.activeProcesses, this.finishedProcessCount, 'process')}
          ${this.renderSection(this.activeSubagents, this.finishedSubagentCount, 'subagent')}
        </div>
      </details>
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
          <span class="task-name" title=${child.agentName}
            >${child.agentName}</span
          >
          <span class="task-status task-status--running">running</span>
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

  private handleToggle(e: ToggleEvent): void {
    // Only react to the outer panel-root toggle, not bubbled inner <details>
    if (e.target !== e.currentTarget) return;
    this.open = (e.currentTarget as HTMLDetailsElement).open;
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

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
