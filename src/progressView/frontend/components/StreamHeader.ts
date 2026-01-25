// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - progress view constants
import {
  COMMANDS,
  ELEMENT_IDS,
  STREAM_STATUS,
  TOOLBAR_BUTTONS,
} from '../constants';
import { ProgressEvents } from '../events';
import type { StreamState } from '../store';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

@customElement('stream-header')
export class StreamHeader extends LitElement {
  @property({ type: Object }) stream: StreamTabInfo | null = null;
  @property({ type: Object }) streamState: StreamState | null = null;
  @property({ type: String }) runId: string | null = null;
  @property({ type: Array }) runs: Array<{
    id: string;
    name: string;
    startTime?: number | string;
  }> = [];

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | typeof nothing {
    if (!this.stream) {
      return nothing;
    }

    const status = this.resolveStatus();
    const statusLabel = this.getStatusLabel(status);
    const hasExecutionId = Boolean(this.stream.executionId);
    const agentCategory = this.stream.agentCategory;
    const toolbarButtons =
      TOOLBAR_BUTTONS[agentCategory] ?? TOOLBAR_BUTTONS.workflow;

    return html`
      <div class="log-header">
        <div class="log-header__primary">
          <div class="header-left">
            <div class="stream-header">
              <span
                id=${ELEMENT_IDS.ACTIVE_STREAM_NAME}
                data-stream=${this.stream.name}
                title=${ifDefined(this.stream.label || undefined)}
              >
                ${this.stream.label || this.stream.name}
              </span>
            </div>
            <span
              id=${ELEMENT_IDS.STATUS_INDICATOR}
              class=${classMap({
                'status-indicator': true,
                [`is-${status}`]: Boolean(status),
              })}
              data-status=${statusLabel}
            ></span>
            ${this.renderRunSelector()}
          </div>
          <div class="header-actions">
            <vscode-toolbar-container
              id=${ELEMENT_IDS.TOOLBAR_CONTAINER}
              data-agent-mode=${agentCategory}
              @click=${this.handleToolbarClick}
            >
              ${toolbarButtons.map((btn) => {
                const { disabled, hidden } = this.resolveButtonState(
                  btn.id,
                  status,
                  hasExecutionId,
                );
                return html`
                  <vscode-toolbar-button
                    id=${btn.id}
                    icon=${btn.icon}
                    label=${btn.title}
                    title=${btn.title}
                    data-command=${btn.command}
                    aria-hidden=${hidden ? 'true' : 'false'}
                    ?disabled=${disabled}
                    class=${classMap({
                      [btn.className || '']: Boolean(btn.className),
                      'toolbar-button--hidden': hidden,
                    })}
                  ></vscode-toolbar-button>
                `;
              })}
            </vscode-toolbar-container>
          </div>
        </div>
      </div>
    `;
  }

  private renderRunSelector(): TemplateResult | typeof nothing {
    if (!this.stream) {
      return nothing;
    }

    const isWorkflow = this.stream.agentCategory === 'workflow';
    const hasRuns = this.runs.length > 0;
    if (!isWorkflow) {
      return nothing;
    }

    return html`
      <div
        id=${ELEMENT_IDS.RUN_SELECTOR_CONTAINER}
        class="run-selector"
        ?hidden=${!hasRuns}
        aria-hidden=${hasRuns ? 'false' : 'true'}
      >
        <div class="run-selector-title" aria-hidden="true">
          <i class="codicon codicon-history"></i>
          <span>Sessions</span>
        </div>
        <run-selector
          .runs=${this.runs}
          .activeRunId=${this.runId}
          @run-selected=${this.handleRunSelected}
        ></run-selector>
      </div>
    `;
  }

  private resolveStatus(): string {
    const status =
      this.streamState?.status || this.stream?.status || STREAM_STATUS.READY;
    return status === STREAM_STATUS.READY ? STREAM_STATUS.STOPPED : status;
  }

  private getStatusLabel(status: string): string {
    const labelMap: Record<string, string> = {
      [STREAM_STATUS.RUNNING]: 'Running',
      [STREAM_STATUS.ERROR]: 'Error',
      [STREAM_STATUS.STOPPED]: 'Stopped',
      [STREAM_STATUS.READY]: 'Ready',
      [STREAM_STATUS.WAITING]: 'Waiting for follow-up',
      [STREAM_STATUS.RESUMING]: 'Resuming',
    };
    return labelMap[status] ?? status;
  }

  private resolveButtonState(
    buttonId: string,
    status: string,
    hasExecutionId: boolean,
  ): { disabled: boolean; hidden: boolean } {
    const executionDependent = new Set([
      ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ELEMENT_IDS.RESUME_BTN,
    ]);

    const statusMap: Record<string, string[]> = {
      [STREAM_STATUS.RUNNING]: [
        ELEMENT_IDS.STOP_STREAM_BTN,
        ELEMENT_IDS.RESTORE_STATE_BTN,
        ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ],
      [STREAM_STATUS.ERROR]: [
        ELEMENT_IDS.RUN_NEW_BTN,
        ELEMENT_IDS.RESUME_BTN,
        ELEMENT_IDS.PACK_STREAM_BTN,
        ELEMENT_IDS.CLEAN_STREAM_BTN,
        ELEMENT_IDS.RESTORE_STATE_BTN,
        ELEMENT_IDS.DIFF_STREAM_BTN,
        ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ],
      [STREAM_STATUS.STOPPED]: [
        ELEMENT_IDS.RUN_NEW_BTN,
        ELEMENT_IDS.RESUME_BTN,
        ELEMENT_IDS.PACK_STREAM_BTN,
        ELEMENT_IDS.CLEAN_STREAM_BTN,
        ELEMENT_IDS.RESTORE_STATE_BTN,
        ELEMENT_IDS.DIFF_STREAM_BTN,
        ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ],
      [STREAM_STATUS.READY]: [
        ELEMENT_IDS.RUN_NEW_BTN,
        ELEMENT_IDS.PACK_STREAM_BTN,
        ELEMENT_IDS.CLEAN_STREAM_BTN,
        ELEMENT_IDS.RESTORE_STATE_BTN,
        ELEMENT_IDS.DIFF_STREAM_BTN,
        ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ],
      [STREAM_STATUS.WAITING]: [
        ELEMENT_IDS.STOP_STREAM_BTN,
        ELEMENT_IDS.RESTORE_STATE_BTN,
        ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ],
      [STREAM_STATUS.RESUMING]: [
        ELEMENT_IDS.STOP_STREAM_BTN,
        ELEMENT_IDS.RESTORE_STATE_BTN,
        ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
      ],
    };

    const enabledButtons = new Set(statusMap[status] ?? []);
    const hidden = executionDependent.has(buttonId) && !hasExecutionId;
    const disabled = hidden || !enabledButtons.has(buttonId);

    return { disabled, hidden };
  }

  private handleToolbarClick(event: MouseEvent) {
    const target = event.target as Element | null;
    if (!target) return;
    const button = target.closest('[data-command]') as HTMLElement | null;
    if (!button || button.hasAttribute('disabled')) return;

    const command = button.dataset.command;
    if (!command) return;

    this.dispatchEvent(ProgressEvents.toolbarCommand({ command }));
  }

  private handleRunSelected(event: CustomEvent) {
    this.dispatchEvent(ProgressEvents.runSelected(event.detail));
  }
}
