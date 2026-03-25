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

// Local imports
import { STREAM_STATUS, type ActiveChildInfo } from '@shared/schemas';
import {
  designTokens,
  commonViewStyles,
  tintedBadgeStyles,
} from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';
import { ProgressEvents } from '../events';

// Local imports - contexts
import {
  EMPTY_DESCRIPTIONS,
  EMPTY_PROCESS_OUTPUTS,
  processOutputContext,
  streamDescriptionsContext,
  type ProcessOutputMap,
  type StreamDescriptionMap,
} from '../contexts/streamContexts';

// Side-effect imports - sibling components
import './TerminalOutput';

@customElement('background-tasks-panel')
export class BackgroundTasksPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    tintedBadgeStyles,
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
        color: var(--color-warning);
      }

      .task-icon--subagent {
        color: var(--color-info);
      }

      .task-name {
        flex-shrink: 0;
        max-width: 40%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--vscode-foreground);
      }

      .task-name--clickable {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: transparent;
        transition: text-decoration-color var(--transition-fast);
      }

      .task-name--clickable:hover {
        text-decoration-color: var(--vscode-foreground);
      }

      .task-description {
        flex: 1;
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

      /* Variant tints for shared .tinted-badge */
      .tinted-badge--running {
        --_tint: var(--color-warning);
      }

      .tinted-badge--waiting {
        --_tint: var(--color-text-secondary);
      }

      .section-label {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-small) 0 var(--spacing-tiny);
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
        color: var(--vscode-foreground);
      }

      .section-label .codicon {
        font-size: var(--font-size-xs);
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
        padding: var(--spacing-tiny) 0;
        font-size: var(--font-size-xs);
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

  /** Open state — auto-expands when active tasks appear, auto-collapses when all finish. */
  @state() open = false;

  @consume({ context: processOutputContext, subscribe: true })
  @state()
  private processOutputs: ProcessOutputMap = EMPTY_PROCESS_OUTPUTS;

  @consume({ context: streamDescriptionsContext, subscribe: true })
  @state()
  private descriptions: StreamDescriptionMap = EMPTY_DESCRIPTIONS;

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
      <vscode-collapsible
        class="panel-collapsible"
        title="Background Tasks"
        ?open=${this.open}
        @vsc-collapsible-toggle=${this.handleCollapsibleToggle}
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
      </vscode-collapsible>
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
      <details>
        <summary class="section-label">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon ${icon}"></i>
          <span
            >${label}${hasActive
              ? html` &middot; ${active.length} active`
              : nothing}${hasFinished
              ? html` &middot; ${finishedCount} done`
              : nothing}</span
          >
        </summary>
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
      </details>
    `;
  }

  private renderTaskItem(
    child: ActiveChildInfo,
    kind: 'process' | 'subagent',
  ): TemplateResult {
    const icon = getTaskIcon(child, kind);
    const entry = this.processOutputs.get(child.executionId);
    const hasStdout = Boolean(entry?.stdout);
    const hasStderr = Boolean(entry?.stderr);
    const isClickable = kind === 'subagent' && Boolean(child.childStreamId);
    const description = child.childStreamId
      ? this.descriptions.get(child.childStreamId)
      : undefined;

    return html`
      <div class="task-item">
        <div class="task-header">
          <i
            class=${classMap({
              codicon: true,
              [icon]: true,
              'task-icon': true,
              'task-icon--process': kind === 'process' && !AGENT_PROCESS_NAMES.has(child.agentName),
              'task-icon--subagent': kind === 'subagent' || AGENT_PROCESS_NAMES.has(child.agentName),
            })}
          ></i>
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
          <span
            class=${classMap({
              'tinted-badge': true,
              'tinted-badge--running': !isWaiting(child),
              'tinted-badge--waiting': isWaiting(child),
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

  private renderOutputStream(label: string, text: string): TemplateResult {
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

/** Agent names that represent external AI agents (distinct from plain shell processes). */
const AGENT_PROCESS_NAMES = new Set(['codex']);

/** Pick the appropriate codicon for a background task item. */
function getTaskIcon(child: ActiveChildInfo, kind: 'process' | 'subagent'): string {
  if (kind === 'subagent') return 'codicon-server-process';
  if (AGENT_PROCESS_NAMES.has(child.agentName)) return 'codicon-robot';
  return 'codicon-terminal';
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
