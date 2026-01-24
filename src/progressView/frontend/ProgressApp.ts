// Third-party imports
import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { cache } from 'lit/directives/cache.js';
import { when } from 'lit/directives/when.js';
import { z } from 'zod';

// Local imports - shared base
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

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
import {
  AGENT_CATEGORY,
  AgentCategorySchema,
  type LogMessageData,
  type StreamTabId,
  type StreamTabInfo,
  type TaskGroup,
} from '@shared/schemas';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - common helpers
import { copyWithFeedback } from '@common/modules/clipboardUtils.js';
import { setChevronIconHorizontal } from '@common/modules/domUtils.js';
import {
  insertTextAtCursor,
  resolveTextareaTarget,
} from '@common/modules/textareaUtils.js';

// Local imports - progress view frontend
import {
  createEmptyStreamState,
  createInitialState,
  getEffectiveRunId,
  getStreamState,
  type ProgressState,
  type StreamFilter,
  type StreamSort,
  type StreamState,
} from './store';
import './components';
import type { PromptState } from './components/PromptOverlay';
import type {
  FollowupMode,
  FollowupOptions,
} from './components/FollowupSection';
import type { RunInfo } from './components/RunSelector';

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
  text: z.string().optional(),
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

const DeleteStreamSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
  stream: StreamTabIdSchema,
});

const DeleteAllSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
});

const TOGGLE_ICON_CLASSES = new Set([
  'banner-details',
  'file-list-details',
  'missing-outputs-details',
  'latexdiff-details',
  'statistics-details',
  'context-management-details',
]);

@customElement('progress-app')
export class ProgressApp extends BaseWebviewApp {
  @state() private state: ProgressState = createInitialState();
  @state() private prompts: PromptState[] = [];
  @state() private followupOptions: FollowupOptions | null = null;

  protected override onWebviewReady(): void {
    postMessage(PROGRESS_VIEW_COMMANDS.WEBVIEW_READY, {});
  }

  override render() {
    const activeStream = this.getActiveStreamInfo();
    const streamState = activeStream
      ? getStreamState(this.state, activeStream.name)
      : null;
    const runId = streamState ? getEffectiveRunId(streamState) : null;
    const isToolUse = activeStream?.agentCategory === AGENT_CATEGORY.TOOL_USE;
    const usage = runId && streamState ? streamState.runUsage[runId] : null;
    const filesByRound =
      runId && streamState ? streamState.runFiles[runId] : {};
    const hasFiles = Boolean(
      filesByRound && Object.keys(filesByRound).length > 0,
    );

    return html`
      <div
        class="main-container"
        @click=${this.handleRootClick}
        @toggle=${this.handleRootToggle}
      >
        <vscode-split-layout>
          <div class="content-area">
            ${when(activeStream, () => {
              if (!activeStream) return null;
              return html`
                <stream-header
                  .stream=${activeStream}
                  .status=${streamState?.status ??
                  activeStream?.status ??
                  'ready'}
                  .agentCategory=${activeStream.agentCategory}
                  .executionAvailable=${Boolean(activeStream.executionId)}
                  @command=${this.handleStreamCommand}
                >
                  <run-selector
                    slot="run-selector"
                    .runs=${this.getRunInfo(streamState)}
                    .activeRunId=${streamState?.activeRunId ?? null}
                    .selectedRunId=${streamState?.selectedRunId ?? null}
                    .visible=${!isToolUse}
                    @run-select=${this.handleRunSelect}
                  ></run-selector>
                </stream-header>
                <instruction-panel
                  .instruction=${this.getInstruction(streamState, runId)}
                ></instruction-panel>
              `;
            })}
            ${cache(
              isToolUse
                ? html`
                    <todo-list
                      .todos=${streamState?.todos ?? []}
                      .visible=${Boolean(activeStream)}
                    ></todo-list>
                    <log-list .logs=${streamState?.logs ?? []}></log-list>
                    <usage-panel
                      .usage=${usage}
                      .contextState=${streamState?.contextState ?? null}
                      .visible=${Boolean(activeStream)}
                    ></usage-panel>
                    <file-list
                      .filesByRound=${filesByRound ?? {}}
                      .showRoundHeaders=${false}
                      .visible=${hasFiles}
                    ></file-list>
                    <follow-up-input
                      .streamId=${activeStream?.name ?? null}
                      .value=${streamState?.followUpText ?? ''}
                      .visible=${Boolean(activeStream)}
                      .bypassActive=${streamState?.toolEditBypass ?? false}
                      .recording=${streamState?.isRecording ?? false}
                      .polishing=${streamState?.isPolishing ?? false}
                      @send-followup=${this.handleSendFollowup}
                      @polish-followup=${this.handlePolishFollowup}
                      @clear-followup=${this.handleClearFollowup}
                      @toggle-bypass=${this.handleToggleBypass}
                      @toggle-recording=${this.handleToggleRecording}
                      @followup-input-change=${this.handleFollowupInputChange}
                    >
                      <queued-follow-ups
                        slot="queued"
                        .messages=${streamState?.queuedFollowUps ?? []}
                        .visible=${Boolean(activeStream)}
                      ></queued-follow-ups>
                    </follow-up-input>
                  `
                : html`
                    <task-group-list
                      .groups=${this.getTaskGroups(streamState)}
                      .logs=${streamState?.logs ?? []}
                    ></task-group-list>
                    <usage-panel
                      .usage=${usage}
                      .contextState=${streamState?.contextState ?? null}
                      .visible=${Boolean(activeStream)}
                    ></usage-panel>
                    <file-list
                      .filesByRound=${filesByRound ?? {}}
                      .showRoundHeaders=${true}
                      .visible=${hasFiles}
                    ></file-list>
                    <followup-section
                      .options=${this.followupOptions}
                      .mode=${streamState?.followupMode ?? 'chat'}
                      .agent=${streamState?.followupAgent ?? ''}
                      .model=${streamState?.followupModel ?? ''}
                      .initialQuestion=${streamState?.followupInitialQuestion ??
                      ''}
                      .includeInstruction=${streamState?.followupIncludeInstruction ??
                      false}
                      .attachOutputs=${streamState?.followupAttachOutputs ??
                      false}
                      .visible=${this.shouldShowFollowupSection(
                        activeStream,
                        streamState,
                        runId,
                      )}
                      @followup-state-change=${this.handleFollowupStateChange}
                      @followup-opened=${this.handleFollowupOpened}
                      @followup-setup=${this.handleFollowupSetup}
                      @followup-run=${this.handleFollowupRun}
                    ></followup-section>
                  `,
            )}
          </div>
          <stream-tabs
            .streams=${this.getFilteredStreams()}
            .activeStream=${this.state.activeStreamId}
            .filter=${this.state.streamFilter}
            .sort=${this.state.streamSort}
            @stream-select=${this.handleStreamSelect}
            @stream-delete=${this.handleStreamDelete}
            @stream-delete-all=${this.handleDeleteAll}
            @filter-change=${this.handleFilterChange}
            @sort-change=${this.handleSortChange}
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

  private getTaskGroups(streamState: StreamState | null): TaskGroup[] {
    if (!streamState) return [];
    return Object.values(streamState.taskGroups);
  }

  private getRunInfo(streamState: StreamState | null): RunInfo[] {
    if (!streamState) return [];
    const groups = Object.values(streamState.taskGroups).filter(
      (group) => !group.parentGroupId,
    );
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      startTime: group.startTime,
    }));
  }

  private getInstruction(
    streamState: StreamState | null,
    runId: string | null,
  ) {
    if (!streamState || !runId) return null;
    return streamState.runInstructions[runId]?.text ?? null;
  }

  private shouldShowFollowupSection(
    stream: StreamTabInfo | null,
    streamState: StreamState | null,
    runId: string | null,
  ) {
    if (
      !stream ||
      !streamState ||
      stream.agentCategory !== AGENT_CATEGORY.WORKFLOW
    ) {
      return false;
    }
    if (streamState.status !== 'stopped') return false;
    if (!runId) return false;
    const files = streamState.runFiles[runId];
    const fileCount = files
      ? Object.values(files).reduce((sum, round) => sum + round.length, 0)
      : 0;
    return fileCount > 0;
  }

  private handleRootClick = async (event: Event) => {
    if (!(event.target instanceof Element)) return;

    const commandElement = event.target.closest('[data-command]');
    if (commandElement instanceof HTMLElement) {
      const { command, file, base, prev } = commandElement.dataset;
      if (command) {
        postMessage(command, {
          ...(file && { file }),
          ...(base && { base }),
          ...(prev && { prev }),
        });
        return;
      }
    }

    const fileLink = event.target.closest('.file-link');
    if (fileLink instanceof HTMLElement && fileLink.dataset.file) {
      const payload: Record<string, unknown> = { file: fileLink.dataset.file };
      if (fileLink.dataset.fileLine) {
        payload.line = Number(fileLink.dataset.fileLine);
      }
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_FILE, payload);
      return;
    }

    const latexRef = event.target.closest('.latex-ref');
    if (latexRef instanceof HTMLElement && latexRef.dataset.label) {
      postMessage(PROGRESS_VIEW_COMMANDS.OPEN_LABEL, {
        label: latexRef.dataset.label,
      });
      return;
    }

    const copyButton = event.target.closest('.banner-content-copy');
    if (copyButton instanceof HTMLElement) {
      event.stopPropagation();
      const contentElem = copyButton
        .closest('.banner-details')
        ?.querySelector('.banner-content') as HTMLElement | null;
      if (!contentElem) return;

      const textToCopy =
        contentElem.dataset.rawContent ?? contentElem.textContent ?? '';
      if (!textToCopy.trim()) return;

      await copyWithFeedback(copyButton, textToCopy, {
        defaultTitle:
          copyButton.dataset.defaultTitle ||
          copyButton.getAttribute('title') ||
          'Copy content',
        successTitle: copyButton.dataset.successTitle || 'Copied!',
      });
      return;
    }

    const codeBlockCopy = event.target.closest('.code-block-copy');
    if (codeBlockCopy instanceof HTMLElement) {
      event.stopPropagation();
      const codeBlock = codeBlockCopy.closest('.code-block');
      const codeElem = codeBlock?.querySelector('code');
      if (!codeElem) return;

      const textToCopy = codeElem.textContent ?? '';
      if (!textToCopy.trim()) return;

      await copyWithFeedback(codeBlockCopy, textToCopy, {
        defaultTitle: 'Copy to clipboard',
        successTitle: 'Copied!',
        successClass: 'copied',
      });
    }
  };

  private handleRootToggle = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const hasToggleClass = Array.from(TOGGLE_ICON_CLASSES).some((cls) =>
      target.classList.contains(cls),
    );
    if (!hasToggleClass) return;

    const toggleIcon = target.querySelector('.toggle-icon');
    if (toggleIcon) {
      setChevronIconHorizontal(toggleIcon, (target as HTMLDetailsElement).open);
    }
  };

  private handleStreamCommand = (event: CustomEvent<{ command: string }>) => {
    if (!this.state.activeStreamId) return;
    postMessage(event.detail.command, { stream: this.state.activeStreamId });
  };

  private handleStreamSelect = (event: CustomEvent<{ streamId: string }>) => {
    postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, {
      stream: event.detail.streamId,
    });
  };

  private handleStreamDelete = (event: CustomEvent<{ streamId: string }>) => {
    postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, {
      stream: event.detail.streamId,
    });
  };

  private handleDeleteAll = () => {
    postMessage(PROGRESS_VIEW_COMMANDS.DELETE_ALL, {});
  };

  private handleFilterChange = (
    event: CustomEvent<{ filter: StreamFilter }>,
  ) => {
    this.state = { ...this.state, streamFilter: event.detail.filter };
    postMessage(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, {
      filter: event.detail.filter,
    });
  };

  private handleSortChange = (event: CustomEvent<{ sort: StreamSort }>) => {
    this.state = { ...this.state, streamSort: event.detail.sort };
    postMessage(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, {
      sortBy: event.detail.sort,
    });
  };

  private handleRunSelect = (event: CustomEvent<{ runId: string | null }>) => {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      selectedRunId: event.detail.runId,
    }));
  };

  private handleFollowupInputChange = (
    event: CustomEvent<{ text: string }>,
  ) => {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      followUpText: event.detail.text,
    }));
  };

  private handleSendFollowup = (event: CustomEvent<{ text: string }>) => {
    const streamId = this.state.activeStreamId;
    const text = event.detail.text.trim();
    if (!streamId || !text) return;
    postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
      stream: streamId,
      text,
    });
    this.setStreamState(streamId, (prev) => ({ ...prev, followUpText: '' }));
  };

  private handlePolishFollowup = (event: CustomEvent<{ text: string }>) => {
    const streamId = this.state.activeStreamId;
    const text = event.detail.text.trim();
    if (!streamId || !text) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, isPolishing: true }));
    postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
      stream: streamId,
      text,
    });
  };

  private handleClearFollowup = () => {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, followUpText: '' }));
  };

  private handleToggleBypass = () => {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    postMessage(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS, {
      stream: streamId,
    });
  };

  private handleToggleRecording = (
    event: CustomEvent<{ recording: boolean }>,
  ) => {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    postMessage(
      event.detail.recording
        ? PROGRESS_VIEW_COMMANDS.START_RECORDING
        : PROGRESS_VIEW_COMMANDS.STOP_RECORDING,
      {},
    );
  };

  private handleFollowupStateChange = (
    event: CustomEvent<{
      mode?: FollowupMode;
      agent?: string;
      model?: string;
      initialQuestion?: string;
      includeInstruction?: boolean;
      attachOutputs?: boolean;
    }>,
  ) => {
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      followupMode: event.detail.mode ?? prev.followupMode,
      followupAgent: event.detail.agent ?? prev.followupAgent,
      followupModel: event.detail.model ?? prev.followupModel,
      followupInitialQuestion:
        event.detail.initialQuestion ?? prev.followupInitialQuestion,
      followupIncludeInstruction:
        event.detail.includeInstruction ?? prev.followupIncludeInstruction,
      followupAttachOutputs:
        event.detail.attachOutputs ?? prev.followupAttachOutputs,
    }));
  };

  private handleFollowupOpened = () => {
    postMessage(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS, {});
  };

  private handleFollowupSetup = () => {
    const payload = this.buildFollowupPayload();
    if (!payload) return;
    postMessage(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP, payload);
  };

  private handleFollowupRun = () => {
    const payload = this.buildFollowupPayload();
    if (!payload) return;
    postMessage(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP, payload);
  };

  private buildFollowupPayload() {
    const streamId = this.state.activeStreamId;
    if (!streamId) return null;
    const streamState = getStreamState(this.state, streamId);
    const mode = streamState.followupMode;
    const agent = mode === 'merge' ? 'merge' : streamState.followupAgent;
    const model =
      streamState.followupModel || this.followupOptions?.defaultMergeModel;
    if (!agent || !model) return null;

    return {
      stream: streamId,
      mode,
      agent,
      model,
      includeInstruction:
        mode === 'workflow' ? streamState.followupIncludeInstruction : false,
      attachAgentOutputs:
        mode === 'workflow' ? streamState.followupAttachOutputs : false,
      initialQuestion: streamState.followupInitialQuestion.trim(),
    };
  }

  private handlePromptAction = (event: CustomEvent) => {
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
  };

  protected handleMessage(raw: unknown): void {
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
      [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: () =>
        this.handleDeleteStream(raw),
      [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () =>
        this.handleDeleteAllMessage(raw),
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

    const sortedMessages = [...messages].sort((a, b) => {
      const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return timeA - timeB;
    });

    this.setStreamState(stream, (prev) => {
      const next = { ...prev };
      if (action === 'clear') {
        next.logs = [];
        next.taskGroups = {};
      } else {
        next.logs = sortedMessages;
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
      const existingRounds = reset ? {} : { ...(runFiles[runId] ?? {}) };
      runFiles[runId] = { ...existingRounds, ...rounds };
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
      const existingRounds = reset
        ? {}
        : { ...(runMissingOutputs[runId] ?? {}) };
      runMissingOutputs[runId] = { ...existingRounds, ...rounds };
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
    this.setStreamState(stream, (prev) => ({
      ...prev,
      runUsage: { ...prev.runUsage, [runId]: usage },
    }));
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
    this.setStreamState(result.data.stream, (prev) => ({
      ...prev,
      taskGroups: {
        ...prev.taskGroups,
        [result.data.group.id]: result.data.group,
      },
    }));
  }

  private handleUpdateTaskGroup(raw: unknown) {
    const result = UpdateTaskGroupMessageSchema.safeParse(raw);
    if (!result.success) return;
    const { streamId, id, status, endTime } = result.data.update;
    this.setStreamState(streamId, (prev) => {
      const existing = prev.taskGroups[id];
      if (!existing) return prev;
      return {
        ...prev,
        taskGroups: {
          ...prev.taskGroups,
          [id]: {
            ...existing,
            status: status ?? existing.status,
            endTime: endTime ?? existing.endTime,
          },
        },
      };
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

  private handleFollowUpTextPolished(raw: unknown) {
    const result = FollowUpTextPolishedSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({
      ...prev,
      followUpText: result.data.text,
      isPolishing: false,
    }));
  }

  private handleFollowUpTextTranscribed(raw: unknown) {
    const result = FollowUpTextTranscribedSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;

    const text = result.data.text ?? '';
    const textarea = this.querySelector('#followUpInput');
    const resolved = resolveTextareaTarget(textarea as HTMLElement | null);
    if (resolved?.textarea && text) {
      insertTextAtCursor(resolved.textarea, text);
      this.setStreamState(streamId, (prev) => ({
        ...prev,
        followUpText: resolved.textarea?.value ?? prev.followUpText,
        isRecording: false,
      }));
      return;
    }

    this.setStreamState(streamId, (prev) => ({
      ...prev,
      isRecording: false,
    }));
  }

  private handleRecordingStarted(raw: unknown) {
    if (!RecordingStartedSchema.safeParse(raw).success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, isRecording: true }));
  }

  private handleRecordingStopped(raw: unknown) {
    if (!RecordingStoppedSchema.safeParse(raw).success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, isRecording: false }));
  }

  private handleRecordingError(raw: unknown) {
    if (!RecordingErrorSchema.safeParse(raw).success) return;
    const streamId = this.state.activeStreamId;
    if (!streamId) return;
    this.setStreamState(streamId, (prev) => ({ ...prev, isRecording: false }));
  }

  private handleSetFollowupOptions(raw: unknown) {
    const result = SetFollowupOptionsSchema.safeParse(raw);
    if (!result.success) return;
    this.followupOptions = {
      workflowAgentsHtml: result.data.workflowAgentsHtml,
      toolUseAgentsHtml: result.data.toolUseAgentsHtml,
      modelOptionsHtml: result.data.modelOptionsHtml,
      defaultMergeModel: result.data.defaultMergeModel,
    };
  }

  private handleDeleteStream(raw: unknown) {
    const result = DeleteStreamSchema.safeParse(raw);
    if (!result.success) return;
    const streamId = result.data.stream;
    const nextStates = new Map(this.state.streamStates);
    nextStates.delete(streamId);
    this.state = {
      ...this.state,
      streams: this.state.streams.filter((stream) => stream.name !== streamId),
      streamStates: nextStates,
      activeStreamId:
        this.state.activeStreamId === streamId
          ? null
          : this.state.activeStreamId,
    };
  }

  private handleDeleteAllMessage(raw: unknown) {
    if (!DeleteAllSchema.safeParse(raw).success) return;
    this.state = createInitialState();
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
    updater: (prev: StreamState) => StreamState,
  ) {
    const nextStates = new Map(this.state.streamStates);
    const current = getStreamState(this.state, streamId);
    nextStates.set(streamId, updater(current));
    this.state = { ...this.state, streamStates: nextStates };
  }

  private updateStreamInfo(streams: StreamTabInfo[]) {
    const nextStates = new Map(this.state.streamStates);
    const knownStreams = new Set(streams.map((stream) => stream.name));
    for (const key of nextStates.keys()) {
      if (!knownStreams.has(key)) {
        nextStates.delete(key);
      }
    }
    for (const stream of streams) {
      const existing = nextStates.get(stream.name) ?? createEmptyStreamState();
      const followupModel = existing.followupModel || stream.model || '';
      nextStates.set(stream.name, {
        ...existing,
        info: stream,
        followupModel,
      });
    }
    this.state = { ...this.state, streams, streamStates: nextStates };
  }
}
