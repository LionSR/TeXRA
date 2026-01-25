// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared styles
// Note: Design tokens from tokens.css are inherited into Shadow DOM via :root
import { codiconStyles } from '@shared/styles/codiconStyles';

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

interface ToolbarButton {
  id: string;
  icon: string;
  iconActive?: string;
  command: string;
  title: string;
  titleActive?: string;
  className?: string;
  disabled?: boolean;
  isToggle?: boolean;
}

/** Status display labels - extracted as constant to avoid recreation on each render */
const STATUS_LABELS: Record<string, string> = {
  [STREAM_STATUS.RUNNING]: 'Running',
  [STREAM_STATUS.ERROR]: 'Error',
  [STREAM_STATUS.STOPPED]: 'Stopped',
  [STREAM_STATUS.READY]: 'Ready',
  [STREAM_STATUS.WAITING]: 'Waiting for follow-up',
  [STREAM_STATUS.RESUMING]: 'Resuming',
};

/**
 * Buttons enabled per status - extracted as constant to avoid recreation.
 * Maps status to array of button IDs that should be enabled.
 */
const ENABLED_BUTTONS_BY_STATUS: Record<string, string[]> = {
  [STREAM_STATUS.RUNNING]: [
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.YOLO_TOGGLE_BTN,
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
    ELEMENT_IDS.YOLO_TOGGLE_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ],
  [STREAM_STATUS.RESUMING]: [
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.YOLO_TOGGLE_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ],
};

/** Buttons that depend on having an executionId */
const EXECUTION_DEPENDENT_BUTTONS = new Set([
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.RESUME_BTN,
]);

@customElement('stream-header')
export class StreamHeader extends LitElement {
  static styles = [
    codiconStyles,
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .log-header {
        padding: var(--spacing-tiny) var(--spacing-small);
        font-size: var(--font-size-sm);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        color: var(--color-text-secondary);
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .log-header__primary {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
      }

      .log-header__secondary {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        font-size: var(--font-size-sm);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
        flex: 1;
        min-width: 0;
      }

      .stream-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        min-width: 0;
      }

      .stream-header #activeStreamName {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .run-selector {
        min-width: 180px;
        max-width: 260px;
        flex-shrink: 0;
      }

      .run-selector-title {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        font-weight: 500;
        white-space: nowrap;
      }

      .run-selector-title .codicon {
        font-size: var(--font-size-icon);
        line-height: 1;
      }

      .header-actions {
        flex-shrink: 0;
        margin-left: auto;
      }

      .status-indicator {
        width: var(--spacing-medium);
        height: var(--spacing-medium);
        border-radius: 50%;
        display: inline-block;
        margin: 0 var(--spacing-small);
        position: relative;
        opacity: var(--opacity-subtle);
        transition: all 0.3s ease;
      }

      .status-indicator:hover {
        opacity: var(--opacity-full);
      }

      .status-indicator::after {
        content: attr(data-status);
        position: absolute;
        left: 50%;
        top: 100%;
        transform: translateX(-50%);
        margin-top: var(--spacing-tiny);
        padding: var(--spacing-small) var(--spacing-medium);
        background: var(--background-color);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius-small);
        font-size: var(--font-size-sm);
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
        z-index: 100;
      }

      .status-indicator:hover::after {
        opacity: var(--opacity-full);
      }

      .status-indicator.is-ready {
        background-color: var(--vscode-descriptionForeground);
        opacity: var(--opacity-disabled);
      }

      .status-indicator.is-running {
        background-color: var(--color-success);
        box-shadow: 0 0 4px var(--color-success);
        opacity: 1;
        animation: pulse-scale 2s infinite;
      }

      .status-indicator.is-error {
        background-color: var(--color-error);
        box-shadow: 0 0 4px var(--color-error);
        opacity: 1;
      }

      .status-indicator.is-waiting,
      .status-indicator.is-resuming {
        background-color: var(--vscode-textLink-foreground);
        box-shadow: 0 0 4px var(--vscode-textLink-foreground);
        opacity: 1;
        animation: pulse-scale 3s infinite;
      }

      .status-indicator.is-resuming {
        animation-duration: 1.5s;
      }

      .status-indicator.is-stopped {
        background-color: var(--vscode-descriptionForeground);
        opacity: var(--opacity-subtle);
      }

      @keyframes pulse-scale {
        0%,
        100% {
          transform: scale(1);
          opacity: 1;
        }
        50% {
          transform: scale(1.15);
          opacity: 0.8;
        }
      }

      .toolbar-button--hidden {
        display: none;
      }

      @media (max-width: 500px) {
        .log-header {
          flex-wrap: wrap;
          gap: var(--spacing-small);
        }

        .header-left {
          flex-basis: 100%;
        }

        .header-actions {
          margin-left: auto;
        }
      }
    `,
  ];

  @property({ type: Object }) stream: StreamTabInfo | null = null;
  @property({ type: Object }) streamState: StreamState | null = null;
  @property({ type: String }) runId: string | null = null;
  @property({ type: Array }) runs: Array<{
    id: string;
    name: string;
    startTime: number;
  }> = [];
  @property({ type: Boolean }) yoloActive = false;

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
          </div>
          <div class="header-actions">
            <vscode-toolbar-container
              id=${ELEMENT_IDS.TOOLBAR_CONTAINER}
              data-agent-mode=${agentCategory}
              @click=${this.handleToolbarClick}
            >
              ${(toolbarButtons as ToolbarButton[]).map((btn) => {
                const { disabled, hidden } = this.resolveButtonState(
                  btn.id,
                  status,
                  hasExecutionId,
                );
                const isActive = Boolean(btn.isToggle && this.yoloActive);
                const icon =
                  isActive && btn.iconActive ? btn.iconActive : btn.icon;
                const title =
                  isActive && btn.titleActive ? btn.titleActive : btn.title;
                return html`
                  <vscode-toolbar-button
                    id=${btn.id}
                    icon=${icon}
                    label=${title}
                    title=${title}
                    data-command=${btn.command}
                    aria-hidden=${hidden ? 'true' : 'false'}
                    ?disabled=${disabled}
                    class=${classMap({
                      [btn.className || '']: Boolean(btn.className),
                      'toolbar-button--hidden': hidden,
                      'is-active': isActive,
                    })}
                  ></vscode-toolbar-button>
                `;
              })}
            </vscode-toolbar-container>
          </div>
        </div>
        ${this.renderRunSelector()}
      </div>
    `;
  }

  private renderRunSelector(): TemplateResult | typeof nothing {
    // Note: this.stream is guaranteed to exist when this method is called
    // since render() only calls it when stream is truthy
    const isWorkflow = this.stream!.agentCategory === 'workflow';
    if (!isWorkflow) {
      return nothing;
    }
    const hasRuns = this.runs.length > 0;
    if (!hasRuns) {
      return nothing;
    }

    return html`
      <div class="log-header__secondary">
        <div id=${ELEMENT_IDS.RUN_SELECTOR_CONTAINER} class="run-selector">
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
      </div>
    `;
  }

  private resolveStatus(): string {
    const status =
      this.streamState?.status || this.stream?.status || STREAM_STATUS.READY;
    return status === STREAM_STATUS.READY ? STREAM_STATUS.STOPPED : status;
  }

  private getStatusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
  }

  private resolveButtonState(
    buttonId: string,
    status: string,
    hasExecutionId: boolean,
  ): { disabled: boolean; hidden: boolean } {
    const enabledButtons = new Set(ENABLED_BUTTONS_BY_STATUS[status] ?? []);
    const hidden = EXECUTION_DEPENDENT_BUTTONS.has(buttonId) && !hasExecutionId;
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
