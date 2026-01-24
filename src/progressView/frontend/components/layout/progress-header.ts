// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import { AgentCategory, STREAM_STATUS } from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import {
  commandsContext,
  streamContext,
  type CommandsContextValue,
  type StreamContextValue,
} from '../../context';

/**
 * Renders the ProgressView header with stream controls.
 */
@customElement('progress-header')
export class ProgressHeader extends LitElement {
  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  @consume({ context: streamContext })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  private handleStreamAction(command: string): void {
    const streamId = this.streamData?.activeStreamId;
    if (!streamId) return;
    this.commands.postCommand(command, { stream: streamId });
  }

  private handleStreamStop(): void {
    const streamId = this.streamData?.activeStreamId;
    if (!streamId) return;
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.STOP_STREAM, {
      stream: streamId,
    });
  }

  private handleToolEditBypassToggle(): void {
    const streamId = this.streamData?.activeStreamId;
    if (!streamId) return;
    this.commands.postCommand(
      PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS,
      { stream: streamId },
    );
  }

  private renderToolbar() {
    const activeStream = this.streamData?.activeStream;
    if (!activeStream) {
      return html`<div class="toolbar"></div>`;
    }

    const isWorkflow = activeStream.agentCategory === AgentCategory.Workflow;
    const bypassActive =
      this.streamData?.toolEditBypass[activeStream.name ?? ''] ?? false;

    return html`
      <div class="toolbar">
        <button class="secondary" @click=${this.handleStreamStop}>Stop</button>
        ${isWorkflow
          ? html`
              <button
                class="secondary"
                @click=${() =>
                  this.handleStreamAction(PROGRESS_VIEW_COMMANDS.RUN_NEW)}
              >
                Run New
              </button>
              <button
                class="secondary"
                @click=${() =>
                  this.handleStreamAction(PROGRESS_VIEW_COMMANDS.RESUME)}
              >
                Resume
              </button>
              <button
                class="ghost"
                @click=${() =>
                  this.handleStreamAction(PROGRESS_VIEW_COMMANDS.DIFF_STREAM)}
              >
                Diff
              </button>
              <button
                class="ghost"
                @click=${() =>
                  this.handleStreamAction(PROGRESS_VIEW_COMMANDS.CLEAN_STREAM)}
              >
                Clean
              </button>
              <button
                class="ghost"
                @click=${() =>
                  this.handleStreamAction(PROGRESS_VIEW_COMMANDS.PACK_STREAM)}
              >
                Pack
              </button>
            `
          : null}
        <button
          class="ghost"
          @click=${() =>
            this.handleStreamAction(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE)}
        >
          Open Storage
        </button>
        <button
          class="ghost"
          @click=${() =>
            this.handleStreamAction(PROGRESS_VIEW_COMMANDS.RESTORE_STATE)}
        >
          Restore
        </button>
        <button class="ghost" @click=${this.handleToolEditBypassToggle}>
          ${bypassActive ? 'Disable YOLO' : 'Enable YOLO'}
        </button>
      </div>
    `;
  }

  render() {
    const status = this.streamData?.activeStatus ?? STREAM_STATUS.READY;
    return html`
      <div class="header">
        <div class="header-row">
          <stream-tabs-panel></stream-tabs-panel>
          <span class="status-pill">${status}</span>
        </div>
        <stream-filters></stream-filters>
        ${this.renderToolbar()}
      </div>
    `;
  }
}
