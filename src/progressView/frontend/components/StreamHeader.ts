// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

// Local imports - progress view
import { TOOLBAR_BUTTONS } from '../constants';
import type { ToolbarButtonDefinition } from '../constants';
import type { StreamStatus, StreamTabInfo } from '@shared/schemas';

const EXECUTION_DEPENDENT_BUTTONS = new Set([
  'openTaskStorageBtn',
  'resumeBtn',
]);

const STATUS_BUTTONS: Record<string, string[]> = {
  running: ['stopStreamBtn', 'restoreStateBtn', 'openTaskStorageBtn'],
  error: [
    'runNewBtn',
    'resumeBtn',
    'packStreamBtn',
    'cleanStreamBtn',
    'restoreStateBtn',
    'diffStreamBtn',
    'openTaskStorageBtn',
  ],
  stopped: [
    'runNewBtn',
    'resumeBtn',
    'packStreamBtn',
    'cleanStreamBtn',
    'restoreStateBtn',
    'diffStreamBtn',
    'openTaskStorageBtn',
  ],
  ready: [
    'runNewBtn',
    'packStreamBtn',
    'cleanStreamBtn',
    'restoreStateBtn',
    'diffStreamBtn',
    'openTaskStorageBtn',
  ],
  waiting: ['stopStreamBtn', 'restoreStateBtn', 'openTaskStorageBtn'],
  resuming: ['stopStreamBtn', 'restoreStateBtn', 'openTaskStorageBtn'],
  initializing: ['stopStreamBtn', 'restoreStateBtn', 'openTaskStorageBtn'],
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  error: 'Error',
  stopped: 'Stopped',
  ready: 'Ready',
  waiting: 'Waiting for follow-up',
  resuming: 'Resuming',
  initializing: 'Initializing',
};

@customElement('stream-header')
export class StreamHeader extends LitElement {
  @property({ type: Object }) stream: StreamTabInfo | null = null;
  @property({ type: String }) status: StreamStatus = 'ready';
  @property({ type: String }) agentCategory: 'workflow' | 'toolUse' =
    'workflow';
  @property({ type: Boolean }) executionAvailable = false;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private handleCommand(command: string) {
    if (!this.stream) return;
    this.dispatchEvent(
      new CustomEvent('command', {
        detail: { command, stream: this.stream.name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private isButtonEnabled(button: ToolbarButtonDefinition): boolean {
    const enabledButtons = STATUS_BUTTONS[this.status] ?? [];
    if (!enabledButtons.includes(button.id)) return false;
    if (EXECUTION_DEPENDENT_BUTTONS.has(button.id)) {
      return this.executionAvailable;
    }
    return true;
  }

  private isButtonHidden(button: ToolbarButtonDefinition): boolean {
    return (
      EXECUTION_DEPENDENT_BUTTONS.has(button.id) && !this.executionAvailable
    );
  }

  private renderToolbar() {
    const buttons = TOOLBAR_BUTTONS[this.agentCategory] ?? [];
    return html`
      <div class="header-actions">
        <div id="toolbarContainer">
          ${buttons.map((button) => {
            const isHidden = this.isButtonHidden(button);
            const isEnabled = this.isButtonEnabled(button);
            const buttonClasses = classMap({
              [button.className]: true,
              'toolbar-button--hidden': isHidden,
            });
            return html`
              <vscode-toolbar-button
                id=${button.id}
                class=${buttonClasses}
                icon=${button.icon}
                title=${button.title}
                aria-label=${button.title}
                ?disabled=${!isEnabled}
                data-command=${button.command}
                @click=${() => this.handleCommand(button.command)}
              ></vscode-toolbar-button>
            `;
          })}
        </div>
      </div>
    `;
  }

  override render() {
    const statusLabel = STATUS_LABELS[this.status] ?? this.status;
    const statusClasses = classMap({
      'status-indicator': true,
      [`is-${this.status}`]: true,
    });

    return html`
      <div class="log-header">
        <div class="log-header__primary">
          <div class="header-left">
            <div class="stream-header">
              <span
                id="activeStreamName"
                title=${this.stream?.label ?? ''}
                data-stream=${this.stream?.name ?? ''}
                >${this.stream?.label ?? ''}</span
              >
              <span class=${statusClasses} data-status=${statusLabel}></span>
            </div>
            <slot name="run-selector"></slot>
          </div>
          ${when(this.stream, () => this.renderToolbar())}
        </div>
      </div>
    `;
  }
}
