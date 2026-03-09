/**
 * Collapsible panel for displaying background tasks (processes and subagents).
 *
 * Shows a summary badge in the collapsed header and a list of active/finished
 * tasks when expanded, similar to the ContextManagement pattern.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';

// Local imports - types
import type { ActiveChildInfo } from '@shared/schemas';

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

      details {
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
      }

      .badge-count--active {
        color: var(--color-warning, var(--vscode-charts-orange));
        background: color-mix(
          in srgb,
          var(--color-warning, var(--vscode-charts-orange)) 12%,
          transparent
        );
      }

      .badge-count--done {
        color: var(--color-text-secondary);
        background: color-mix(
          in srgb,
          var(--color-text-secondary) 12%,
          transparent
        );
      }

      .task-list {
        list-style: none;
        margin: 0;
        padding: 0 var(--spacing-medium) var(--spacing-small);
      }

      .task-item {
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
        flex-shrink: 0;
        font-size: var(--font-size-xs, 10px);
        padding: 1px var(--spacing-small);
        border-radius: var(--border-radius-small);
      }

      .task-status--running {
        color: var(--color-warning, var(--vscode-charts-orange));
        background: color-mix(
          in srgb,
          var(--color-warning, var(--vscode-charts-orange)) 12%,
          transparent
        );
      }

      .task-status--done {
        color: var(--color-success);
        background: color-mix(in srgb, var(--color-success) 12%, transparent);
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
    `,
  ];

  @property({ attribute: false }) activeProcesses: ActiveChildInfo[] = [];
  @property({ attribute: false }) finishedProcessCount = 0;
  @property({ attribute: false }) activeSubagents: ActiveChildInfo[] = [];
  @property({ attribute: false }) finishedSubagentCount = 0;
  @property({ type: Boolean }) open = false;

  /** Total number of background tasks (active + finished). */
  private get totalTasks(): number {
    return (
      this.activeProcesses.length +
      this.finishedProcessCount +
      this.activeSubagents.length +
      this.finishedSubagentCount
    );
  }

  private get totalActive(): number {
    return this.activeProcesses.length + this.activeSubagents.length;
  }

  private get totalFinished(): number {
    return this.finishedProcessCount + this.finishedSubagentCount;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.totalTasks === 0) return nothing;

    return html`
      <details ?open=${this.open} @toggle=${this.handleToggle}>
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-terminal panel-icon"></i>
          <span class="panel-title">Background Tasks</span>
          ${this.renderSummaryBadges()}
        </summary>
        <div class="task-list">
          ${this.renderProcessSection()} ${this.renderSubagentSection()}
        </div>
      </details>
    `;
  }

  private renderSummaryBadges(): TemplateResult | typeof nothing {
    const parts: TemplateResult[] = [];
    if (this.totalActive > 0) {
      parts.push(
        html`<span class="badge-count badge-count--active"
          >${this.totalActive} running</span
        >`,
      );
    }
    if (this.totalFinished > 0) {
      parts.push(
        html`<span class="badge-count badge-count--done"
          >${this.totalFinished} done</span
        >`,
      );
    }
    return parts.length > 0 ? html`${parts}` : nothing;
  }

  private renderProcessSection(): TemplateResult | typeof nothing {
    const hasActive = this.activeProcesses.length > 0;
    const hasFinished = this.finishedProcessCount > 0;
    if (!hasActive && !hasFinished) return nothing;

    return html`
      <div class="section-label">
        <i class="codicon codicon-terminal"></i>
        <span
          >Processes${hasActive
            ? html` &middot; ${this.activeProcesses.length} active`
            : nothing}${hasFinished
            ? html` &middot; ${this.finishedProcessCount} done`
            : nothing}</span
        >
      </div>
      ${hasActive
        ? repeat(
            this.activeProcesses,
            (p) => p.executionId,
            (p) => this.renderTaskItem(p, 'process', true),
          )
        : nothing}
      ${!hasActive && hasFinished
        ? html`<div class="empty-message">
            All ${this.finishedProcessCount} processes completed
          </div>`
        : nothing}
    `;
  }

  private renderSubagentSection(): TemplateResult | typeof nothing {
    const hasActive = this.activeSubagents.length > 0;
    const hasFinished = this.finishedSubagentCount > 0;
    if (!hasActive && !hasFinished) return nothing;

    return html`
      <div class="section-label">
        <i class="codicon codicon-server-process"></i>
        <span
          >Subagents${hasActive
            ? html` &middot; ${this.activeSubagents.length} active`
            : nothing}${hasFinished
            ? html` &middot; ${this.finishedSubagentCount} done`
            : nothing}</span
        >
      </div>
      ${hasActive
        ? repeat(
            this.activeSubagents,
            (s) => s.executionId,
            (s) => this.renderTaskItem(s, 'subagent', true),
          )
        : nothing}
      ${!hasActive && hasFinished
        ? html`<div class="empty-message">
            All ${this.finishedSubagentCount} subagents completed
          </div>`
        : nothing}
    `;
  }

  private renderTaskItem(
    child: ActiveChildInfo,
    kind: 'process' | 'subagent',
    isRunning: boolean,
  ): TemplateResult {
    const icon =
      kind === 'process' ? 'codicon-terminal' : 'codicon-server-process';
    return html`
      <div class="task-item">
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
        <span
          class=${classMap({
            'task-status': true,
            'task-status--running': isRunning,
            'task-status--done': !isRunning,
          })}
          >${isRunning ? 'running' : 'done'}</span
        >
      </div>
    `;
  }

  private handleToggle(e: ToggleEvent): void {
    this.open = (e.target as HTMLDetailsElement).open;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
