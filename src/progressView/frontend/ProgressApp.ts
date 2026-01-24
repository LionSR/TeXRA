// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { z } from 'zod';

// Local imports - shared agent categories
import { AGENT_CATEGORY, AgentCategorySchema } from '@shared/schemas';

// Local imports - shared schemas
import {
  AgentProposalPromptSchema,
  BashApprovalPromptSchema,
  InstructionUpdateSchema,
  LogMessageDataSchema,
  OutputFileInfoSchema,
  RetryRequestPromptSchema,
  StreamStatusSchema,
  StreamTabIdSchema,
  StreamTabInfoSchema,
  TaskGroupSchema,
  TodoItemSchema,
  TokenUsageStatsSchema,
  ToolEditApprovalPromptSchema,
  UpdateTaskGroupPayloadSchema,
} from '@shared/schemas';
import type {
  LogMessageData,
  OutputFileInfo,
  StreamTabId,
  StreamTabInfo,
} from '@shared/schemas';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view frontend
import { postMessage } from './vscode';
import {
  createEmptyStreamState,
  createInitialState,
  getEffectiveRunId,
  getStreamState,
  type ProgressState,
  type StreamFilter,
  type StreamSort,
} from './store';
import './components/PromptOverlay';
import type { PromptState } from './components/PromptOverlay';

const AgentCategoryFilterSchema = z.union([
  z.literal('all'),
  AgentCategorySchema,
]);

const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
  agentFilter: AgentCategoryFilterSchema,
});

const UpdateLogsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_LOGS),
  stream: StreamTabIdSchema,
  messages: z.array(LogMessageDataSchema),
  groups: z.array(TaskGroupSchema).optional(),
  action: z.enum(['render', 'clear']).optional(),
  runInstructions: z.record(z.string(), InstructionUpdateSchema).optional(),
  activeRunId: z.string().nullable().optional(),
  runUsage: z.record(z.string(), TokenUsageStatsSchema).optional(),
  runFiles: z
    .record(z.string(), z.record(z.string(), z.array(OutputFileInfoSchema)))
    .optional(),
  runMissingOutputs: z
    .record(z.string(), z.record(z.string(), z.array(z.string())))
    .optional(),
  contextState: z
    .object({
      inputTokens: z.number(),
      contextWindow: z.number(),
      utilizationPercent: z.number(),
    })
    .optional(),
});

const AppendLogMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.APPEND_LOG),
  stream: StreamTabIdSchema,
  logMessage: LogMessageDataSchema,
});

const UpdateLogMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_LOG),
  stream: StreamTabIdSchema,
  logMessage: LogMessageDataSchema,
});

const UpdateStatusMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STATUS),
  status: StreamStatusSchema,
});

const UpdateStreamStatusMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS),
  stream: StreamTabIdSchema,
  status: StreamStatusSchema,
  lastTimestamp: z.number().optional(),
});

const UpdateFilesMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FILES),
  stream: StreamTabIdSchema,
  runId: z.string().optional(),
  rounds: z.record(z.string(), z.array(OutputFileInfoSchema)).optional(),
  reset: z.boolean().optional(),
});

const UpdateMissingOutputsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS),
  stream: StreamTabIdSchema,
  runId: z.string().optional(),
  rounds: z.record(z.string(), z.array(z.string())).optional(),
  reset: z.boolean().optional(),
});

const UpdateInstructionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION),
  stream: z.union([StreamTabIdSchema, z.literal('')]),
  instruction: InstructionUpdateSchema.nullable(),
  agentCategory: z.string().optional(),
});

const UpdateQueuedFollowUpsSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
  stream: StreamTabIdSchema,
  messages: z.array(z.string()),
});

const UpdateRunUsageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE),
  stream: StreamTabIdSchema,
  runId: z.string(),
  usage: TokenUsageStatsSchema,
});

const UpdateContextStateSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE),
  stream: StreamTabIdSchema,
  contextState: z.object({
    inputTokens: z.number(),
    contextWindow: z.number(),
    utilizationPercent: z.number(),
  }),
});

const AddTaskGroupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP),
  stream: StreamTabIdSchema,
  group: TaskGroupSchema,
});

const UpdateTaskGroupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP),
  update: UpdateTaskGroupPayloadSchema,
});

const UpdateTodosMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  stream: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});

const ShowToolEditApprovalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL),
  request: ToolEditApprovalPromptSchema,
});

const ResolveToolEditApprovalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL),
  requestId: z.string(),
});

const UpdateToolEditApprovalStateSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE),
  stream: StreamTabIdSchema,
  bypassActive: z.boolean(),
});

const ShowBashApprovalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL),
  request: BashApprovalPromptSchema,
});

const ResolveBashApprovalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL),
  requestId: z.string(),
});

const ShowRetryRequestSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST),
  request: RetryRequestPromptSchema,
});

const ResolveRetryRequestSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST),
  streamId: StreamTabIdSchema,
});

const ShowAgentProposalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL),
  proposal: AgentProposalPromptSchema,
});

const ResolveAgentProposalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL),
  proposalId: z.string(),
});

@customElement('progress-app')
export class ProgressApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100vh;
    }

    .main-container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .stream-tabs {
      display: flex;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-wrap: wrap;
    }

    .stream-tab {
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid transparent;
      background: var(--vscode-sideBar-background);
    }

    .stream-tab.active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-button-secondaryBackground);
    }

    .content-area {
      flex: 1;
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .status-indicator {
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      background: var(--vscode-editor-background);
    }

    .section h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
    }

    .logs {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .log-entry {
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      font-size: 12px;
      white-space: pre-wrap;
    }

    .task-group-list,
    .todo-list,
    .file-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .todo-item {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
    }

    .follow-up {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    textarea {
      width: 100%;
      min-height: 80px;
      resize: vertical;
    }
  `;

  @state() private state: ProgressState = createInitialState();
  @state() private prompts: PromptState[] = [];
  @state() private followUpText = '';

  private readonly messageListener = (event: MessageEvent) => {
    this.handleMessage(event.data);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.messageListener);
    postMessage(PROGRESS_VIEW_COMMANDS.WEBVIEW_READY, {});
  }

  disconnectedCallback(): void {
    window.removeEventListener('message', this.messageListener);
    super.disconnectedCallback();
  }

  render() {
    const activeStream = this.getActiveStreamInfo();
    const streamState = activeStream
      ? getStreamState(this.state, activeStream.name)
      : null;
    const runId = streamState ? getEffectiveRunId(streamState) : null;

    return html`
      <div class="main-container">
        ${this.renderStreamTabs()}
        <div class="content-area">
          ${activeStream
            ? html`
                ${this.renderHeader(activeStream, streamState)}
                ${this.renderInstruction(streamState, runId)}
                ${this.renderTaskGroups(streamState, activeStream)}
                ${this.renderTodos(streamState, activeStream)}
                ${this.renderLogs(streamState)}
                ${this.renderUsage(streamState, runId)}
                ${this.renderFiles(streamState, runId)}
                ${this.renderQueuedFollowUps(streamState)}
                ${this.renderFollowUpInput(activeStream)}
              `
            : html`<div class="section">No active streams yet.</div>`}
        </div>
      </div>
      <prompt-overlay
        ?hidden=${this.prompts.length === 0}
        .prompt=${this.prompts.at(0) ?? null}
        @prompt-action=${this.handlePromptAction}
      ></prompt-overlay>
    `;
  }

  private renderStreamTabs() {
    const streams = this.getFilteredStreams();
    return html`
      <div class="stream-tabs">
        <div class="toolbar">
          <button @click=${() => this.setFilter('all')}>All</button>
          <button @click=${() => this.setFilter('workflow')}>Workflow</button>
          <button @click=${() => this.setFilter('toolUse')}>Tool use</button>
          <button @click=${() => this.setSort('time')}>Sort: Time</button>
          <button @click=${() => this.setSort('agent')}>Sort: Agent</button>
          <button @click=${() => this.setSort('inputFile')}>Sort: File</button>
        </div>
        ${streams.map((stream) => {
          const isActive = stream.name === this.state.activeStreamId;
          return html`
            <div
              class="stream-tab ${isActive ? 'active' : ''}"
              @click=${() => this.switchStream(stream.name)}
            >
              ${stream.label}
            </div>
          `;
        })}
        ${streams.length === 0 ? html`<span>No streams available</span>` : null}
      </div>
    `;
  }

  private renderHeader(
    activeStream: StreamTabInfo,
    streamState: ReturnType<typeof getStreamState> | null,
  ) {
    const status = streamState?.status ?? activeStream.status ?? 'ready';
    return html`
      <div class="log-header section">
        <div>
          <div><strong>${activeStream.label}</strong></div>
          <div class="status-indicator">${status}</div>
          ${this.renderRunSelector(activeStream, streamState)}
        </div>
        <div class="toolbar">
          <button
            @click=${() =>
              this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.STOP_STREAM)}
          >
            Stop
          </button>
          ${activeStream.agentCategory === AGENT_CATEGORY.WORKFLOW
            ? html`
                <button
                  @click=${() =>
                    this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.RUN_NEW)}
                >
                  Run new
                </button>
                <button
                  @click=${() =>
                    this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.RESUME)}
                >
                  Resume
                </button>
                <button
                  @click=${() =>
                    this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.DIFF_STREAM)}
                >
                  Diff
                </button>
                <button
                  @click=${() =>
                    this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.CLEAN_STREAM)}
                >
                  Clean
                </button>
                <button
                  @click=${() =>
                    this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.PACK_STREAM)}
                >
                  Pack
                </button>
              `
            : html``}
          <button
            @click=${() =>
              this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.RESTORE_STATE)}
          >
            Restore
          </button>
          <button
            @click=${() =>
              this.sendStreamCommand(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE)}
          >
            Storage
          </button>
        </div>
      </div>
    `;
  }

  private renderRunSelector(
    activeStream: StreamTabInfo,
    streamState: ReturnType<typeof getStreamState> | null,
  ): TemplateResult | null {
    if (
      !streamState ||
      activeStream.agentCategory !== AGENT_CATEGORY.WORKFLOW
    ) {
      return null;
    }
    const runIds = new Set<string>([
      ...Object.keys(streamState.runInstructions),
      ...Object.keys(streamState.runUsage),
      ...Object.keys(streamState.runFiles),
    ]);
    if (runIds.size === 0) return null;
    const selected = getEffectiveRunId(streamState) ?? '';
    return html`
      <div>
        <label>
          Run:
          <select
            @change=${(event: Event) =>
              this.handleRunSelection(event, activeStream.name)}
          >
            ${[...runIds].map(
              (id) =>
                html`<option value=${id} ?selected=${id === selected}>
                  ${id}
                </option>`,
            )}
          </select>
        </label>
      </div>
    `;
  }

  private handleRunSelection(event: Event, streamId: StreamTabId) {
    const target = event.target as HTMLSelectElement | null;
    const runId = target?.value ?? '';
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      selectedRunId: runId || null,
    }));
  }

  private renderInstruction(
    streamState: ReturnType<typeof getStreamState> | null,
    runId: string | null,
  ) {
    if (!streamState || !runId) return null;
    const instruction = streamState.runInstructions[runId];
    if (!instruction) return null;
    return html`
      <div class="section">
        <h3>Instruction</h3>
        <pre>${instruction.text}</pre>
      </div>
    `;
  }

  private renderTaskGroups(
    streamState: ReturnType<typeof getStreamState> | null,
    activeStream: StreamTabInfo,
  ) {
    if (!streamState) return null;
    const groups = Object.values(streamState.taskGroups);
    if (groups.length === 0) return null;
    return html`
      <div class="section">
        <h3>
          ${activeStream.agentCategory === AGENT_CATEGORY.WORKFLOW
            ? 'Task groups'
            : 'Turns'}
        </h3>
        <div class="task-group-list">
          ${groups.map(
            (group) => html`
              <div><strong>${group.name}</strong> – ${group.status}</div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderTodos(
    streamState: ReturnType<typeof getStreamState> | null,
    activeStream: StreamTabInfo,
  ) {
    if (
      !streamState ||
      activeStream.agentCategory !== AGENT_CATEGORY.TOOL_USE
    ) {
      return null;
    }
    if (streamState.todos.length === 0) return null;
    return html`
      <div class="section">
        <h3>Todos</h3>
        <div class="todo-list">
          ${streamState.todos.map(
            (todo) => html`
              <div class="todo-item">
                <span>${todo.content}</span>
                <span>${todo.status}</span>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderLogs(streamState: ReturnType<typeof getStreamState> | null) {
    if (!streamState) return null;
    return html`
      <div class="section">
        <h3>Logs</h3>
        <div class="logs">
          ${streamState.logs.map(
            (log) => html`
              <div class="log-entry">
                <strong>${log.messageType ?? log.level}</strong>: ${log.text}
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderFiles(
    streamState: ReturnType<typeof getStreamState> | null,
    runId: string | null,
  ) {
    if (!streamState || !runId) return null;
    const roundMap = streamState.runFiles[runId];
    if (!roundMap || Object.keys(roundMap).length === 0) return null;
    const rounds = Object.entries(roundMap)
      .map(([round, files]) => [Number(round), files] as const)
      .sort((a, b) => a[0] - b[0]);
    return html`
      <div class="section">
        <h3>Output files</h3>
        <div class="file-list">
          ${rounds.map(
            ([round, files]) => html`
              <div>
                <strong>Round ${round}</strong>
                <ul>
                  ${files.map(
                    (file) => html`
                      <li>
                        <a @click=${() => this.openFile(file)}>
                          ${file.source}
                        </a>
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderUsage(
    streamState: ReturnType<typeof getStreamState> | null,
    runId: string | null,
  ) {
    if (!streamState || !runId) return null;
    const usage = streamState.runUsage[runId];
    if (!usage && !streamState.contextState) return null;
    return html`
      <div class="section">
        <h3>Usage</h3>
        ${usage
          ? html`
              <div>Input tokens: ${usage.inputTokens}</div>
              <div>Output tokens: ${usage.outputTokens}</div>
              <div>Cost: $${usage.cost.toFixed(4)}</div>
            `
          : null}
        ${streamState.contextState
          ? html`
              <div>
                Context: ${streamState.contextState.utilizationPercent}% used
              </div>
            `
          : null}
      </div>
    `;
  }

  private renderQueuedFollowUps(
    streamState: ReturnType<typeof getStreamState> | null,
  ) {
    if (!streamState || streamState.queuedFollowUps.length === 0) return null;
    return html`
      <div class="section">
        <h3>Queued follow-ups</h3>
        <ul>
          ${streamState.queuedFollowUps.map((item) => html`<li>${item}</li>`)}
        </ul>
      </div>
    `;
  }

  private renderFollowUpInput(activeStream: StreamTabInfo) {
    return html`
      <div class="section follow-up">
        <h3>Follow-up</h3>
        <textarea
          .value=${this.followUpText}
          @input=${(event: InputEvent) => this.updateFollowUpText(event)}
        ></textarea>
        <div class="toolbar">
          <button @click=${() => this.sendFollowUp(activeStream.name)}>
            Send
          </button>
          <button @click=${() => this.polishFollowUp(activeStream.name)}>
            Polish
          </button>
          <button @click=${() => this.toggleBypass(activeStream.name)}>
            ${this.getBypassLabel(activeStream.name)}
          </button>
        </div>
      </div>
    `;
  }

  private updateFollowUpText(event: InputEvent) {
    const target = event.target as HTMLTextAreaElement | null;
    this.followUpText = target?.value ?? '';
  }

  private sendFollowUp(streamId: StreamTabId) {
    const text = this.followUpText.trim();
    if (!text) return;
    postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
      stream: streamId,
      text,
    });
    this.followUpText = '';
  }

  private polishFollowUp(streamId: StreamTabId) {
    const text = this.followUpText.trim();
    if (!text) return;
    postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
      stream: streamId,
      text,
    });
  }

  private toggleBypass(streamId: StreamTabId) {
    postMessage(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS, {
      stream: streamId,
    });
  }

  private getBypassLabel(streamId: StreamTabId): string {
    const streamState = getStreamState(this.state, streamId);
    return streamState.toolEditBypass ? 'Disable YOLO' : 'Enable YOLO';
  }

  private openFile(file: OutputFileInfo) {
    postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, {
      file: file.location.absolutePath,
    });
  }

  private switchStream(streamId: StreamTabId) {
    postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
  }

  private setFilter(filter: StreamFilter) {
    this.state = { ...this.state, streamFilter: filter };
    postMessage(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, { filter });
  }

  private setSort(sort: StreamSort) {
    this.state = { ...this.state, streamSort: sort };
    postMessage(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, { sortBy: sort });
  }

  private sendStreamCommand(command: string) {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    postMessage(command, { stream: streamId });
  }

  private getActiveStreamInfo(): StreamTabInfo | null {
    if (!this.state.activeStreamId) return null;
    return (
      this.state.streams.find(
        (stream) => stream.name === this.state.activeStreamId,
      ) ?? null
    );
  }

  private getFilteredStreams(): StreamTabInfo[] {
    const streams = [...this.state.streams];
    const filter = this.state.streamFilter;
    const sorted = this.sortStreams(streams, this.state.streamSort);
    if (filter === 'all') return sorted;
    return sorted.filter((stream) => stream.agentCategory === filter);
  }

  private sortStreams(
    streams: StreamTabInfo[],
    sort: StreamSort,
  ): StreamTabInfo[] {
    return [...streams].sort((a, b) => {
      switch (sort) {
        case 'agent':
          return (a.agent ?? '').localeCompare(b.agent ?? '');
        case 'inputFile':
          return (a.inputFile ?? '').localeCompare(b.inputFile ?? '');
        case 'time':
        default: {
          const aTime = a.lastTimestamp ?? a.creationTimestamp ?? 0;
          const bTime = b.lastTimestamp ?? b.creationTimestamp ?? 0;
          return bTime - aTime;
        }
      }
    });
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (
      prev: ReturnType<typeof getStreamState>,
    ) => ReturnType<typeof getStreamState>,
  ) {
    const current = getStreamState(this.state, streamId);
    this.state = {
      ...this.state,
      streamStates: {
        ...this.state.streamStates,
        [streamId]: updater(current),
      },
    };
  }

  private updateStreamInfo(streams: StreamTabInfo[]) {
    const nextStates = { ...this.state.streamStates };
    const knownStreams = new Set(streams.map((stream) => stream.name));
    for (const key of Object.keys(nextStates)) {
      if (!knownStreams.has(key)) {
        delete nextStates[key];
      }
    }
    for (const stream of streams) {
      const existing = nextStates[stream.name] ?? createEmptyStreamState();
      nextStates[stream.name] = { ...existing, info: stream };
    }
    this.state = { ...this.state, streams, streamStates: nextStates };
  }

  private handlePromptAction(event: CustomEvent) {
    const { prompt, action } = event.detail as {
      prompt: PromptState;
      action: string;
    };
    switch (prompt.kind) {
      case 'toolEdit':
        postMessage(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
          requestId: prompt.data.requestId,
          action,
        });
        break;
      case 'bash':
        postMessage(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION, {
          requestId: prompt.data.requestId,
          action,
        });
        break;
      case 'retry':
        if (action === 'retry') {
          postMessage(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST, {
            stream: prompt.data.streamId,
          });
        } else {
          postMessage(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST, {
            stream: prompt.data.streamId,
          });
        }
        break;
      case 'proposal':
        postMessage(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
          proposalId: prompt.data.proposalId,
          action,
        });
        break;
    }
  }

  private handleMessage(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as { command?: string };
    if (!message.command) return;

    const handlers: Record<string, () => void> = {
      [PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]: () =>
        this.handleUpdateStreams(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]: () => this.handleUpdateLogs(raw),
      [PROGRESS_VIEW_COMMANDS.APPEND_LOG]: () => this.handleAppendLog(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_LOG]: () => this.handleUpdateLog(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_STATUS]: () =>
        this.handleUpdateStatus(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: () =>
        this.handleUpdateStreamStatus(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: () => this.handleUpdateFiles(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: () =>
        this.handleUpdateMissingOutputs(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION]: () =>
        this.handleUpdateInstruction(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: () =>
        this.handleUpdateQueuedFollowUps(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: () =>
        this.handleUpdateRunUsage(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE]: () =>
        this.handleUpdateContextState(raw),
      [PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP]: () =>
        this.handleAddTaskGroup(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP]: () =>
        this.handleUpdateTaskGroup(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: () => this.handleUpdateTodos(raw),
      [PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL]: () =>
        this.handleShowToolEditApproval(raw),
      [PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]: () =>
        this.handleResolveToolEditApproval(raw),
      [PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE]: () =>
        this.handleUpdateToolEditApprovalState(raw),
      [PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL]: () =>
        this.handleShowBashApproval(raw),
      [PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL]: () =>
        this.handleResolveBashApproval(raw),
      [PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST]: () =>
        this.handleShowRetryRequest(raw),
      [PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST]: () =>
        this.handleResolveRetryRequest(raw),
      [PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL]: () =>
        this.handleShowAgentProposal(raw),
      [PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL]: () =>
        this.handleResolveAgentProposal(raw),
    };

    handlers[message.command]?.();
  }

  private handleUpdateStreams(raw: unknown) {
    const result = UpdateStreamsMessageSchema.safeParse(raw);
    if (!result.success) return;
    const activeStream = result.data.activeStream || null;
    this.updateStreamInfo(result.data.streams);
    this.state = {
      ...this.state,
      activeStreamId: activeStream || null,
      streamFilter: result.data.agentFilter as StreamFilter,
    };
  }

  private handleUpdateLogs(raw: unknown) {
    const result = UpdateLogsMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, messages, groups, action } = result.data;

    this.setStreamState(stream, (prev) => {
      const next = { ...prev };
      if (action === 'clear') {
        next.logs = [];
        next.taskGroups = {};
      } else {
        next.logs = messages;
        if (groups) {
          next.taskGroups = Object.fromEntries(
            groups.map((group) => [group.id, group]),
          );
        }
      }
      if (result.data.activeRunId !== undefined) {
        next.activeRunId = result.data.activeRunId;
      }
      if (result.data.runInstructions) {
        next.runInstructions = this.mergeRecord(
          next.runInstructions,
          result.data.runInstructions,
        );
      }
      if (result.data.runUsage) {
        next.runUsage = this.mergeRecord(next.runUsage, result.data.runUsage);
      }
      if (result.data.runFiles) {
        next.runFiles = this.mergeRunRoundRecord(
          next.runFiles,
          result.data.runFiles,
        );
      }
      if (result.data.runMissingOutputs) {
        next.runMissingOutputs = this.mergeRunRoundRecord(
          next.runMissingOutputs,
          result.data.runMissingOutputs,
        );
      }
      if (result.data.contextState) {
        next.contextState = result.data.contextState;
      }
      return next;
    });
  }

  private handleAppendLog(raw: unknown) {
    const result = AppendLogMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      logs: [...prev.logs, result.data.logMessage],
    }));
  }

  private handleUpdateLog(raw: unknown) {
    const result = UpdateLogMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      logs: prev.logs.map((entry) =>
        entry.id === result.data.logMessage.id ? result.data.logMessage : entry,
      ),
    }));
  }

  private handleUpdateStatus(raw: unknown) {
    const result = UpdateStatusMessageSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      status: result.data.status,
    }));
  }

  private handleUpdateStreamStatus(raw: unknown) {
    const result = UpdateStreamStatusMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, status, lastTimestamp } = result.data;
    this.setStreamState(stream, (prev) => ({
      ...prev,
      status,
    }));
    this.state = {
      ...this.state,
      streams: this.state.streams.map((item) =>
        item.name === stream
          ? {
              ...item,
              status,
              lastTimestamp: lastTimestamp ?? item.lastTimestamp,
            }
          : item,
      ),
    };
  }

  private handleUpdateFiles(raw: unknown) {
    const result = UpdateFilesMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, runId, rounds, reset } = result.data;
    if (!runId || !rounds) return;
    this.setStreamState(stream, (prev) => {
      const runFiles = reset ? {} : { ...prev.runFiles };
      const existingRounds = reset ? {} : { ...runFiles[runId] };
      for (const [round, files] of Object.entries(rounds)) {
        existingRounds[round] = files;
      }
      runFiles[runId] = existingRounds;
      return { ...prev, runFiles };
    });
  }

  private handleUpdateMissingOutputs(raw: unknown) {
    const result = UpdateMissingOutputsMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, runId, rounds, reset } = result.data;
    if (!runId || !rounds) return;
    this.setStreamState(stream, (prev) => {
      const runMissingOutputs = reset ? {} : { ...prev.runMissingOutputs };
      const existingRounds = reset ? {} : { ...runMissingOutputs[runId] };
      for (const [round, files] of Object.entries(rounds)) {
        existingRounds[round] = files;
      }
      runMissingOutputs[runId] = existingRounds;
      return { ...prev, runMissingOutputs };
    });
  }

  private handleUpdateInstruction(raw: unknown) {
    const result = UpdateInstructionMessageSchema.safeParse(raw);
    if (!result.success) return;
    if (!result.data.stream) return;
    this.setStreamState(result.data.stream, (prev) => {
      const runId = prev.activeRunId ?? 'default';
      const runInstructions = { ...prev.runInstructions };
      if (result.data.instruction) {
        runInstructions[runId] = result.data.instruction;
      } else {
        delete runInstructions[runId];
      }
      return { ...prev, runInstructions };
    });
  }

  private handleUpdateQueuedFollowUps(raw: unknown) {
    const result = UpdateQueuedFollowUpsSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      queuedFollowUps: result.data.messages,
    }));
  }

  private handleUpdateRunUsage(raw: unknown) {
    const result = UpdateRunUsageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, runId, usage } = result.data;
    this.setStreamState(stream, (prev) => {
      const runUsage = { ...prev.runUsage, [runId]: usage };
      return { ...prev, runUsage };
    });
  }

  private handleUpdateContextState(raw: unknown) {
    const result = UpdateContextStateSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      contextState: result.data.contextState,
    }));
  }

  private handleAddTaskGroup(raw: unknown) {
    const result = AddTaskGroupMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => {
      const taskGroups = {
        ...prev.taskGroups,
        [result.data.group.id]: result.data.group,
      };
      return { ...prev, taskGroups };
    });
  }

  private handleUpdateTaskGroup(raw: unknown) {
    const result = UpdateTaskGroupMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { streamId, id, status, endTime } = result.data.update;
    this.setStreamState(streamId, (prev) => {
      const taskGroups = { ...prev.taskGroups };
      const existing = taskGroups[id];
      if (existing) {
        taskGroups[id] = {
          ...existing,
          status: status ?? existing.status,
          endTime: endTime ?? existing.endTime,
        };
      }
      return { ...prev, taskGroups };
    });
  }

  private handleUpdateTodos(raw: unknown) {
    const result = UpdateTodosMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      todos: result.data.todos,
    }));
  }

  private handleShowToolEditApproval(raw: unknown) {
    const result = ShowToolEditApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'toolEdit', data: result.data.request },
    ];
  }

  private handleResolveToolEditApproval(raw: unknown) {
    const result = ResolveToolEditApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'toolEdit' ||
        prompt.data.requestId !== result.data.requestId,
    );
  }

  private handleUpdateToolEditApprovalState(raw: unknown) {
    const result = UpdateToolEditApprovalStateSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      toolEditBypass: result.data.bypassActive,
    }));
  }

  private handleShowBashApproval(raw: unknown) {
    const result = ShowBashApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'bash', data: result.data.request },
    ];
  }

  private handleResolveBashApproval(raw: unknown) {
    const result = ResolveBashApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'bash' ||
        prompt.data.requestId !== result.data.requestId,
    );
  }

  private handleShowRetryRequest(raw: unknown) {
    const result = ShowRetryRequestSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'retry', data: result.data.request },
    ];
  }

  private handleResolveRetryRequest(raw: unknown) {
    const result = ResolveRetryRequestSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'retry' ||
        prompt.data.streamId !== result.data.streamId,
    );
  }

  private handleShowAgentProposal(raw: unknown) {
    const result = ShowAgentProposalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'proposal', data: result.data.proposal },
    ];
  }

  private handleResolveAgentProposal(raw: unknown) {
    const result = ResolveAgentProposalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'proposal' ||
        prompt.data.proposalId !== result.data.proposalId,
    );
  }

  private mergeRecord<T>(
    current: Record<string, T>,
    record: Record<string, T>,
  ): Record<string, T> {
    return { ...current, ...record };
  }

  private mergeRunRoundRecord<T>(
    current: Record<string, Record<string, T[]>>,
    record: Record<string, Record<string, T[]>>,
  ): Record<string, Record<string, T[]>> {
    const next = { ...current };
    for (const [runId, rounds] of Object.entries(record)) {
      next[runId] = rounds;
    }
    return next;
  }
}
