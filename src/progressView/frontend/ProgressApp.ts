// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';
import { z } from 'zod';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

// Local imports - shared schemas
import {
  AGENT_CATEGORY,
  AgentCategorySchema,
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
  InstructionUpdate,
  OutputFileInfo,
  StreamTabId,
  StreamTabInfo,
  TaskGroup,
} from '@shared/schemas';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { createThemeHandlers } from '@common/webview/themeHandlers.js';

// Local imports - progress view frontend
import {
  createEmptyStreamState,
  createInitialState,
  getEffectiveRunId,
  getStreamState,
  type FollowupMode,
  type ProgressState,
  type StreamFilter,
  type StreamSort,
} from './store';

// Local imports - progress view components
import './components/StreamTabs';
import './components/StreamHeader';
import './components/RunSelector';
import './components/InstructionPanel';
import './components/TodoList';
import './components/FileList';
import './components/UsagePanel';
import './components/FollowUpInput';
import './components/FollowupSection';
import './components/TaskGroupList';
import './components/PromptOverlay';

// Local imports - progress view helpers
import type {
  FollowupOptions,
  FollowupStreamData,
} from './components/FollowupSection';
import type { FollowUpInput } from './components/FollowUpInput';
import type { LogList } from './components/LogList';
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

const FollowUpTextPolishedSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED),
  text: z.string(),
});

const FollowUpTextTranscribedSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED),
  text: z.string(),
});

const RecordingStartedSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_STARTED),
});

const RecordingStoppedSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED),
});

const RecordingErrorSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_ERROR),
});

const SetFollowupOptionsSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS),
  workflowAgentsHtml: z.string().optional(),
  toolUseAgentsHtml: z.string().optional(),
  modelOptionsHtml: z.string().optional(),
  defaultMergeModel: z.string().optional(),
});

@customElement('progress-app')
export class ProgressApp extends BaseWebviewApp {
  @state() private state: ProgressState = createInitialState();
  @state() private prompts: PromptState[] = [];

  private logListRef = createRef<LogList>();
  private followUpRef = createRef<FollowUpInput>();

  protected override get readyCommand(): string | null {
    return PROGRESS_VIEW_COMMANDS.WEBVIEW_READY;
  }

  render(): TemplateResult {
    const activeStream = this.getActiveStreamInfo();
    const streamState = activeStream
      ? getStreamState(this.state, activeStream.name)
      : null;
    const runId = streamState ? getEffectiveRunId(streamState) : null;
    const isToolUse =
      activeStream?.agentCategory === AGENT_CATEGORY.TOOL_USE || false;

    return html`
      <div class="main-container">
        <vscode-split-layout split="vertical" initial-handle-position="72%">
          <div slot="start" class="content-area">
            ${activeStream
              ? html`
                  <stream-header
                    .stream=${activeStream}
                    .streamState=${streamState}
                    .runId=${runId}
                    .runs=${this.getRunGroups(streamState?.taskGroups ?? [])}
                    @toolbar-command=${this.handleToolbarCommand}
                    @run-selected=${this.handleRunSelected}
                  ></stream-header>

                  <instruction-panel
                    .instruction=${!isToolUse && runId
                      ? (streamState?.runInstructions?.[runId] ?? null)
                      : null}
                  ></instruction-panel>

                  ${isToolUse
                    ? html`
                        <todo-list
                          .todos=${streamState?.todos ?? []}
                        ></todo-list>
                      `
                    : null}

                  <task-group-list ${ref(this.logListRef)}></task-group-list>

                  <usage-panel
                    .usage=${runId
                      ? (streamState?.runUsage?.[runId] ?? null)
                      : null}
                    .contextState=${streamState?.contextState ?? null}
                  ></usage-panel>

                  <file-list
                    .filesByRound=${runId
                      ? (streamState?.runFiles?.[runId] ?? {})
                      : {}}
                    .showRoundHeaders=${!isToolUse}
                    @file-action=${this.handleFileAction}
                  ></file-list>

                  <follow-up-input
                    ${ref(this.followUpRef)}
                    .visible=${isToolUse}
                    .value=${streamState?.followUpText ?? ''}
                    .yoloActive=${Boolean(streamState?.toolEditBypass)}
                    .queuedMessages=${streamState?.queuedFollowUps ?? []}
                    @followup-change=${this.handleFollowUpChange}
                    @followup-send=${this.handleFollowUpSend}
                    @followup-polish=${this.handleFollowUpPolish}
                    @followup-clear=${this.handleFollowUpClear}
                    @followup-toggle-bypass=${this.handleFollowUpToggleBypass}
                  ></follow-up-input>

                  <followup-section
                    .streamData=${this.buildFollowupData(
                      activeStream,
                      streamState,
                      runId,
                    )}
                    .options=${this.state.followupOptions}
                    .mode=${streamState?.followupMode ?? 'chat'}
                    .streamModel=${activeStream.model ?? null}
                    @followup-request-options=${this
                      .handleFollowupRequestOptions}
                    @followup-mode-change=${this.handleFollowupModeChange}
                    @followup-setup=${this.handleFollowupSetup}
                    @followup-run=${this.handleFollowupRun}
                  ></followup-section>
                `
              : html`
                  <task-group-list ${ref(this.logListRef)}></task-group-list>
                `}
          </div>

          <stream-tabs
            slot="end"
            .streams=${this.getFilteredStreams()}
            .activeStreamId=${this.state.activeStreamId}
            .filter=${this.state.streamFilter}
            .sort=${this.state.streamSort}
            @stream-switch=${this.handleStreamSwitch}
            @stream-delete=${this.handleStreamDelete}
            @filter-change=${this.handleFilterChange}
            @sort-change=${this.handleSortChange}
            @delete-all=${this.handleDeleteAll}
          ></stream-tabs>
        </vscode-split-layout>
      </div>

      <prompt-overlay
        ?hidden=${this.prompts.length === 0}
        .prompt=${this.prompts.at(0) ?? null}
        @prompt-action=${this.handlePromptAction}
      ></prompt-overlay>
    `;
  }

  protected handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as { command?: string };
    if (!message.command) return;

    const themeHandlers = createThemeHandlers({
      commands: PROGRESS_VIEW_COMMANDS,
    }) as Record<string, (message: unknown) => void>;

    const handlers: Record<string, () => void> = {
      ...Object.fromEntries(
        Object.entries(themeHandlers).map(([key, handler]) => [
          key,
          () => handler(raw),
        ]),
      ),
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
      [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED]: () =>
        this.handleFollowUpTextPolished(raw),
      [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]: () =>
        this.handleFollowUpTextTranscribed(raw),
      [PROGRESS_VIEW_COMMANDS.RECORDING_STARTED]: () =>
        this.handleRecordingStarted(raw),
      [PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED]: () =>
        this.handleRecordingStopped(raw),
      [PROGRESS_VIEW_COMMANDS.RECORDING_ERROR]: () =>
        this.handleRecordingError(raw),
      [PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS]: () =>
        this.handleSetFollowupOptions(raw),
    };

    handlers[message.command]?.();
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
    const sorted = this.sortStreams(streams, this.state.streamSort);
    if (this.state.streamFilter === 'all') return sorted;
    return sorted.filter(
      (stream) => stream.agentCategory === this.state.streamFilter,
    );
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

  private getRunGroups(
    groups: TaskGroup[],
  ): Array<{ id: string; name: string; startTime?: number | string }> {
    return groups
      .filter((group) => !group.parentGroupId)
      .map((group) => ({
        id: group.id,
        name: group.name,
        startTime: group.startTime,
      }));
  }

  private buildFollowupData(
    stream: StreamTabInfo,
    streamState: ReturnType<typeof getStreamState> | null,
    runId: string | null,
  ): FollowupStreamData | null {
    if (!stream || !streamState) return null;

    const runFiles = runId ? (streamState.runFiles?.[runId] ?? {}) : {};
    let fileCount = 0;
    for (const files of Object.values(runFiles)) {
      if (Array.isArray(files)) fileCount += files.length;
    }

    const instruction = runId ? streamState.runInstructions?.[runId] : null;
    const instructionPreview = instruction?.text
      ? instruction.text.slice(0, 100) +
        (instruction.text.length > 100 ? '...' : '')
      : null;

    return {
      agentCategory: stream.agentCategory,
      status: streamState.status ?? stream.status,
      hasOutputFiles: fileCount > 0,
      agentName: stream.name.split('@')[0] || stream.name,
      instructionPreview,
      fileCount,
    };
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (
      prev: ReturnType<typeof getStreamState>,
    ) => ReturnType<typeof getStreamState>,
  ): void {
    const nextStates = new Map(this.state.streamStates);
    const current = getStreamState(this.state, streamId);
    nextStates.set(streamId, updater(current));
    this.state = { ...this.state, streamStates: nextStates };
  }

  private updateStreamInfo(streams: StreamTabInfo[]): void {
    const nextStates = new Map(this.state.streamStates);
    const knownStreams = new Set(streams.map((stream) => stream.name));
    for (const key of nextStates.keys()) {
      if (!knownStreams.has(key)) {
        nextStates.delete(key);
      }
    }
    for (const stream of streams) {
      const existing = nextStates.get(stream.name) ?? createEmptyStreamState();
      nextStates.set(stream.name, { ...existing, info: stream });
    }
    this.state = { ...this.state, streams, streamStates: nextStates };
  }

  private refreshActiveStreamLogs(): void {
    const activeStream = this.getActiveStreamInfo();
    const streamState = activeStream
      ? getStreamState(this.state, activeStream.name)
      : null;
    const logList = this.logListRef.value;
    if (!logList || !activeStream || !streamState) {
      return;
    }

    logList.setAgentCategory(activeStream.agentCategory);
    logList.renderLogs({
      streamId: activeStream.name,
      messages: streamState.logs,
      groups: streamState.taskGroups,
      activeRunId: getEffectiveRunId(streamState),
      runInstructions: streamState.runInstructions,
    });
  }

  private handleStreamSwitch(event: CustomEvent): void {
    const { streamId } = event.detail as { streamId: string };
    postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
  }

  private handleStreamDelete(event: CustomEvent): void {
    const { streamId } = event.detail as { streamId: string };
    postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, { stream: streamId });
  }

  private handleFilterChange(event: CustomEvent): void {
    const { filter } = event.detail as { filter: StreamFilter };
    this.state = { ...this.state, streamFilter: filter };
    postMessage(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, { filter });
  }

  private handleSortChange(event: CustomEvent): void {
    const { sort } = event.detail as { sort: StreamSort };
    this.state = { ...this.state, streamSort: sort };
    postMessage(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, { sortBy: sort });
  }

  private handleDeleteAll(): void {
    postMessage(PROGRESS_VIEW_COMMANDS.DELETE_ALL, {});
  }

  private handleToolbarCommand(event: CustomEvent): void {
    const { command } = event.detail as { command: string };
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    postMessage(command, { stream: streamId });
  }

  private handleRunSelected(event: CustomEvent): void {
    const { runId } = event.detail as { runId: string | null };
    const activeStream = this.getActiveStreamInfo();
    if (!activeStream) return;

    this.setStreamState(activeStream.name, (prev) => ({
      ...prev,
      selectedRunId: runId,
    }));

    const logList = this.logListRef.value;
    logList?.showRun(runId ?? null);
  }

  private handleFileAction(event: CustomEvent): void {
    const detail = event.detail as Record<string, string>;
    const { command, ...payload } = detail;
    if (!command) return;
    postMessage(command, payload);
  }

  private handleFollowUpChange(event: CustomEvent): void {
    const { value } = event.detail as { value: string };
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, followUpText: value }));
  }

  private handleFollowUpSend(): void {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    const streamState = getStreamState(this.state, streamId);
    const text = streamState.followUpText?.trim() ?? '';
    if (!text) return;
    postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
      stream: streamId,
      text,
    });
    this.setStreamState(streamId, (prev) => ({ ...prev, followUpText: '' }));
  }

  private handleFollowUpPolish(): void {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    const streamState = getStreamState(this.state, streamId);
    const text = streamState.followUpText?.trim() ?? '';
    if (!text) return;
    postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
      stream: streamId,
      text,
    });
  }

  private handleFollowUpClear(): void {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, followUpText: '' }));
  }

  private handleFollowUpToggleBypass(): void {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    postMessage(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS, {
      stream: streamId,
    });
  }

  private handleFollowupRequestOptions(): void {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    postMessage(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS, {
      stream: streamId,
    });
  }

  private handleFollowupModeChange(event: CustomEvent): void {
    const { mode } = event.detail as { mode: FollowupMode };
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, followupMode: mode }));
  }

  private handleFollowupSetup(): void {
    this.sendFollowupCommand(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP);
  }

  private handleFollowupRun(): void {
    this.sendFollowupCommand(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP);
  }

  private sendFollowupCommand(command: string): void {
    const payload = this.buildFollowupPayload();
    if (!payload) return;
    postMessage(command, payload);
  }

  private buildFollowupPayload(): Record<string, unknown> | null {
    const stream = this.state.activeStreamId;
    if (!stream) return null;

    const mode = getStreamState(this.state, stream).followupMode ?? 'chat';
    const agentSelect = document.getElementById(
      'followupAgent',
    ) as HTMLSelectElement | null;
    const modelSelect = document.getElementById(
      'followupModel',
    ) as HTMLSelectElement | null;
    const includeInstruction =
      (
        document.getElementById(
          'followupIncludeInstruction',
        ) as HTMLInputElement | null
      )?.checked ?? false;
    const attachOutputs =
      (
        document.getElementById(
          'followupAttachOutputs',
        ) as HTMLInputElement | null
      )?.checked ?? false;
    const initialQuestion =
      (
        document.getElementById(
          'followupInitialQuestion',
        ) as HTMLTextAreaElement | null
      )?.value?.trim() ?? '';

    const agent = mode === 'merge' ? 'merge' : agentSelect?.value;
    const model = modelSelect?.value;

    if (!agent || !model) return null;

    return {
      stream,
      mode,
      agent,
      model,
      includeInstruction: mode === 'workflow' ? includeInstruction : false,
      attachAgentOutputs: mode === 'workflow' ? attachOutputs : false,
      initialQuestion,
    };
  }

  private handlePromptAction(event: CustomEvent): void {
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

  private handleUpdateStreams(raw: unknown): void {
    const result = UpdateStreamsMessageSchema.safeParse(raw);
    if (!result.success) return;
    const activeStream = result.data.activeStream || null;

    this.updateStreamInfo(result.data.streams);
    this.state = {
      ...this.state,
      activeStreamId: activeStream || null,
      streamFilter: result.data.agentFilter as StreamFilter,
    };

    queueMicrotask(() => this.refreshActiveStreamLogs());
  }

  private handleUpdateLogs(raw: unknown): void {
    const result = UpdateLogsMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, messages, groups, action } = result.data;

    this.setStreamState(stream, (prev) => {
      const next = { ...prev };
      if (action === 'clear') {
        next.logs = [];
        next.taskGroups = [];
      } else {
        next.logs = messages;
        if (groups) {
          next.taskGroups = groups;
        }
      }
      if (result.data.activeRunId !== undefined) {
        next.activeRunId = result.data.activeRunId;
      }
      if (result.data.runInstructions) {
        next.runInstructions = {
          ...next.runInstructions,
          ...result.data.runInstructions,
        };
      }
      if (result.data.runUsage) {
        next.runUsage = { ...next.runUsage, ...result.data.runUsage };
      }
      if (result.data.runFiles) {
        next.runFiles = { ...next.runFiles, ...result.data.runFiles };
      }
      if (result.data.runMissingOutputs) {
        next.runMissingOutputs = {
          ...next.runMissingOutputs,
          ...result.data.runMissingOutputs,
        };
      }
      if (result.data.contextState) {
        next.contextState = result.data.contextState;
      }
      return next;
    });

    if (this.state.activeStreamId === stream) {
      const logList = this.logListRef.value;
      const streamState = getStreamState(this.state, stream);
      logList?.setAgentCategory(
        streamState.info?.agentCategory ?? AGENT_CATEGORY.WORKFLOW,
      );
      logList?.renderLogs({
        streamId: stream,
        messages: streamState.logs,
        groups: streamState.taskGroups,
        action: action ?? 'render',
        activeRunId: getEffectiveRunId(streamState),
        runInstructions: streamState.runInstructions,
      });
    }
  }

  private handleAppendLog(raw: unknown): void {
    const result = AppendLogMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      logs: [...prev.logs, result.data.logMessage],
    }));

    if (this.state.activeStreamId === result.data.stream) {
      this.logListRef.value?.appendLog(result.data.logMessage);
    }
  }

  private handleUpdateLog(raw: unknown): void {
    const result = UpdateLogMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      logs: prev.logs.map((entry) =>
        entry.id === result.data.logMessage.id ? result.data.logMessage : entry,
      ),
    }));

    if (this.state.activeStreamId === result.data.stream) {
      this.logListRef.value?.updateLog(result.data.logMessage);
    }
  }

  private handleUpdateStatus(raw: unknown): void {
    const result = UpdateStatusMessageSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      status: result.data.status,
    }));

    if (result.data.status === 'waiting') {
      this.followUpRef.value?.focusInput({ scrollIntoView: true });
    }
  }

  private handleUpdateStreamStatus(raw: unknown): void {
    const result = UpdateStreamStatusMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, status, lastTimestamp } = result.data;
    this.setStreamState(stream, (prev) => ({ ...prev, status }));
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

    if (stream === this.state.activeStreamId && status === 'waiting') {
      this.followUpRef.value?.focusInput({ scrollIntoView: true });
    }
  }

  private handleUpdateFiles(raw: unknown): void {
    const result = UpdateFilesMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, runId, rounds, reset } = result.data;
    if (!runId || !rounds) return;
    this.setStreamState(stream, (prev) => {
      const runFiles = reset ? {} : { ...prev.runFiles };
      const existingRounds = reset ? {} : { ...(runFiles[runId] ?? {}) };
      for (const [round, files] of Object.entries(rounds)) {
        existingRounds[round] = files;
      }
      runFiles[runId] = existingRounds;
      return { ...prev, runFiles };
    });
  }

  private handleUpdateMissingOutputs(raw: unknown): void {
    const result = UpdateMissingOutputsMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, runId, rounds, reset } = result.data;
    if (!runId || !rounds) return;
    this.setStreamState(stream, (prev) => {
      const runMissingOutputs = reset ? {} : { ...prev.runMissingOutputs };
      const existingRounds = reset
        ? {}
        : { ...(runMissingOutputs[runId] ?? {}) };
      for (const [round, files] of Object.entries(rounds)) {
        existingRounds[round] = files;
      }
      runMissingOutputs[runId] = existingRounds;
      return { ...prev, runMissingOutputs };
    });
  }

  private handleUpdateInstruction(raw: unknown): void {
    const result = UpdateInstructionMessageSchema.safeParse(raw);
    if (!result.success) return;
    if (!result.data.stream) return;
    this.setStreamState(result.data.stream, (prev) => {
      const runId = prev.activeRunId ?? 'default';
      const runInstructions = { ...prev.runInstructions };
      if (result.data.instruction) {
        runInstructions[runId] = result.data.instruction as InstructionUpdate;
      } else {
        delete runInstructions[runId];
      }
      return { ...prev, runInstructions };
    });
  }

  private handleUpdateQueuedFollowUps(raw: unknown): void {
    const result = UpdateQueuedFollowUpsSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      queuedFollowUps: result.data.messages,
    }));
  }

  private handleUpdateRunUsage(raw: unknown): void {
    const result = UpdateRunUsageSchema.safeParse(raw);
    if (!result.success) return;
    const { stream, runId, usage } = result.data;
    this.setStreamState(stream, (prev) => ({
      ...prev,
      runUsage: { ...prev.runUsage, [runId]: usage },
    }));
  }

  private handleUpdateContextState(raw: unknown): void {
    const result = UpdateContextStateSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      contextState: result.data.contextState,
    }));
  }

  private handleAddTaskGroup(raw: unknown): void {
    const result = AddTaskGroupMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      taskGroups: [...prev.taskGroups, result.data.group],
    }));

    if (this.state.activeStreamId === result.data.stream) {
      this.logListRef.value?.addGroup(result.data.group);
    }
  }

  private handleUpdateTaskGroup(raw: unknown): void {
    const result = UpdateTaskGroupMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { streamId, id, status, endTime } = result.data.update;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      taskGroups: prev.taskGroups.map((group) =>
        group.id === id
          ? {
              ...group,
              status: status ?? group.status,
              endTime: endTime ?? group.endTime,
            }
          : group,
      ),
    }));

    if (this.state.activeStreamId === streamId) {
      this.logListRef.value?.updateGroup({ id, status, endTime });
    }
  }

  private handleUpdateTodos(raw: unknown): void {
    const result = UpdateTodosMessageSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      todos: result.data.todos,
    }));
  }

  private handleShowToolEditApproval(raw: unknown): void {
    const result = ShowToolEditApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'toolEdit', data: result.data.request },
    ];
  }

  private handleResolveToolEditApproval(raw: unknown): void {
    const result = ResolveToolEditApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'toolEdit' ||
        prompt.data.requestId !== result.data.requestId,
    );
  }

  private handleUpdateToolEditApprovalState(raw: unknown): void {
    const result = UpdateToolEditApprovalStateSchema.safeParse(raw);
    if (!result.success) return;
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      toolEditBypass: result.data.bypassActive,
    }));
  }

  private handleShowBashApproval(raw: unknown): void {
    const result = ShowBashApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'bash', data: result.data.request },
    ];
  }

  private handleResolveBashApproval(raw: unknown): void {
    const result = ResolveBashApprovalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'bash' ||
        prompt.data.requestId !== result.data.requestId,
    );
  }

  private handleShowRetryRequest(raw: unknown): void {
    const result = ShowRetryRequestSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'retry', data: result.data.request },
    ];
  }

  private handleResolveRetryRequest(raw: unknown): void {
    const result = ResolveRetryRequestSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'retry' ||
        prompt.data.streamId !== result.data.streamId,
    );
  }

  private handleShowAgentProposal(raw: unknown): void {
    const result = ShowAgentProposalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = [
      ...this.prompts,
      { kind: 'proposal', data: result.data.proposal },
    ];
  }

  private handleResolveAgentProposal(raw: unknown): void {
    const result = ResolveAgentProposalSchema.safeParse(raw);
    if (!result.success) return;
    this.prompts = this.prompts.filter(
      (prompt) =>
        prompt.kind !== 'proposal' ||
        prompt.data.proposalId !== result.data.proposalId,
    );
  }

  private handleFollowUpTextPolished(raw: unknown): void {
    const result = FollowUpTextPolishedSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      followUpText: result.data.text,
    }));
    this.followUpRef.value?.applyPolishedText(result.data.text);
  }

  private handleFollowUpTextTranscribed(raw: unknown): void {
    const result = FollowUpTextTranscribedSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.followUpRef.value?.insertTranscription(result.data.text);
  }

  private handleRecordingStarted(raw: unknown): void {
    const result = RecordingStartedSchema.safeParse(raw);
    if (!result.success) return;
    this.followUpRef.value?.setRecording(true);
  }

  private handleRecordingStopped(raw: unknown): void {
    const result = RecordingStoppedSchema.safeParse(raw);
    if (!result.success) return;
    this.followUpRef.value?.setRecording(false);
  }

  private handleRecordingError(raw: unknown): void {
    const result = RecordingErrorSchema.safeParse(raw);
    if (!result.success) return;
    this.followUpRef.value?.setRecording(false);
  }

  private handleSetFollowupOptions(raw: unknown): void {
    const result = SetFollowupOptionsSchema.safeParse(raw);
    if (!result.success) return;
    const options: FollowupOptions = {
      workflowAgentsHtml: result.data.workflowAgentsHtml ?? '',
      toolUseAgentsHtml: result.data.toolUseAgentsHtml ?? '',
      modelOptionsHtml: result.data.modelOptionsHtml ?? '',
      defaultMergeModel: result.data.defaultMergeModel,
    };
    this.state = { ...this.state, followupOptions: options };
  }
}
