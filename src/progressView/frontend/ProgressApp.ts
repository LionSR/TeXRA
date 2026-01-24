// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { z } from 'zod';

// Local imports - shared schemas
import {
  AgentProposalPromptSchema,
  BashApprovalPromptSchema,
  LogMessageDataSchema,
  OutputFileInfoSchema,
  RetryRequestPromptSchema,
  STREAM_STATUS,
  StreamStatusSchema,
  StreamTabIdSchema,
  StreamTabInfoSchema,
  TaskGroupSchema,
  TokenUsageStatsSchema,
  TodoItemSchema,
  ToolEditApprovalPromptSchema,
  UpdateTaskGroupPayloadSchema,
  type AgentProposalPrompt,
  type BashApprovalPrompt,
  type LogMessageData,
  type OutputFileInfo,
  type RetryRequestPrompt,
  type StreamStatus,
  type StreamTabId,
  type StreamTabInfo,
  type TaskGroup,
  type TokenUsageStats,
  type TodoItem,
  type ToolEditApprovalPrompt,
} from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view types
import {
  InstructionUpdateSchema,
  type InstructionUpdate,
} from '@progressView/types';

// Local imports - agent types
import { AgentCategory } from '@shared/schemas';
import type { AgentCategoryFilter } from '@agent/types/AgentStreamTypes';

// Local imports - webview API
import { postMessage } from './vscode';

interface StreamState {
  logs: LogMessageData[];
  groups: TaskGroup[];
  todos: TodoItem[];
  queuedFollowUps: string[];
  runInstructions: Record<string, InstructionUpdate>;
  activeRunId: string | null;
  outputFilesByRun: Record<string, Record<string, OutputFileInfo[]>>;
  missingOutputsByRun: Record<string, Record<string, string[]>>;
  usageByRun: Record<string, TokenUsageStats>;
  contextState: {
    inputTokens: number;
    contextWindow: number;
    utilizationPercent: number;
  } | null;
  instruction: InstructionUpdate | null;
}

const AgentCategoryFilterSchema = z.enum([
  'all',
  AgentCategory.Workflow,
  AgentCategory.ToolUse,
]);

const RoundFilesSchema = z.record(z.string(), z.array(OutputFileInfoSchema));
const RunFilesSchema = z.record(z.string(), RoundFilesSchema);
const RoundMissingSchema = z.record(z.string(), z.array(z.string()));
const RunMissingSchema = z.record(z.string(), RoundMissingSchema);

const StreamIdSchema = z.union([StreamTabIdSchema, z.literal('')]);

const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: StreamTabIdSchema,
  agentFilter: AgentCategoryFilterSchema,
});

const UpdateLogsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_LOGS),
  stream: StreamTabIdSchema,
  messages: z.array(LogMessageDataSchema),
  groups: z.array(TaskGroupSchema).optional().prefault([]),
  action: z.enum(['render', 'clear']).optional().prefault('render'),
  runInstructions: z.record(z.string(), InstructionUpdateSchema).optional(),
  activeRunId: z.string().nullish(),
  runUsage: z.record(z.string(), TokenUsageStatsSchema).optional(),
  runFiles: RunFilesSchema.optional(),
  runMissingOutputs: RunMissingSchema.optional(),
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

const UpdateUsageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_USAGE),
  stream: StreamTabIdSchema.optional(),
  usageByRun: z.record(z.string(), TokenUsageStatsSchema).prefault({}),
});

const UpdateRunUsageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE),
  stream: StreamTabIdSchema,
  runId: z.string().min(1),
  usage: TokenUsageStatsSchema,
});

const UpdateContextStateMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE),
  stream: StreamTabIdSchema,
  contextState: z.object({
    inputTokens: z.number(),
    contextWindow: z.number(),
    utilizationPercent: z.number(),
  }),
});

const UpdateInstructionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION),
  stream: StreamIdSchema,
  instruction: InstructionUpdateSchema.nullable(),
});

const UpdateFilesMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FILES),
  stream: StreamTabIdSchema,
  runId: z.string().optional(),
  rounds: RoundFilesSchema.optional(),
  reset: z.boolean().optional(),
});

const UpdateMissingOutputsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS),
  stream: StreamTabIdSchema,
  runId: z.string().optional(),
  rounds: RoundMissingSchema.optional(),
  reset: z.boolean().optional(),
});

const UpdateTodosMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  stream: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});

const UpdateQueuedFollowUpsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
  stream: StreamTabIdSchema,
  messages: z.array(z.string()),
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

const ShowToolEditApprovalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL),
  request: ToolEditApprovalPromptSchema,
});

const ResolveToolEditApprovalSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL),
  requestId: z.string().min(1),
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
  requestId: z.string().min(1),
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
  proposalId: z.string().min(1),
});

const EmptyMessageSchema = z.object({
  command: z.string(),
});

const createEmptyStreamState = (): StreamState => ({
  logs: [],
  groups: [],
  todos: [],
  queuedFollowUps: [],
  runInstructions: {},
  activeRunId: null,
  outputFilesByRun: {},
  missingOutputsByRun: {},
  usageByRun: {},
  contextState: null,
  instruction: null,
});

@customElement('progress-app')
export class ProgressApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      height: 100vh;
    }

    .main-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 12px;
      padding: 12px;
      box-sizing: border-box;
    }

    .header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
    }

    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .stream-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .stream-tab {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .stream-tab.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .stream-tab small {
      opacity: 0.7;
    }

    .status-pill {
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button.ghost {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .content {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      flex: 1;
      min-height: 0;
    }

    .panel {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: auto;
    }

    .panel h3 {
      margin: 0;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--vscode-descriptionForeground);
    }

    .log-entry {
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .log-entry:last-child {
      border-bottom: none;
    }

    .log-entry__meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }

    .file-entry {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .file-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .todo-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .todo-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .prompt-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 24px;
      z-index: 1000;
      overflow: auto;
    }

    .prompt-card {
      width: min(720px, 100%);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .prompt-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    textarea {
      width: 100%;
      min-height: 80px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      resize: vertical;
    }

    .empty-state {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  `;

  @state() private streams: StreamTabInfo[] = [];
  @state() private activeStreamId: StreamTabId | null = null;
  @state() private activeStatus: StreamStatus = STREAM_STATUS.READY;
  @state() private streamFilter: AgentCategoryFilter = 'all';
  @state() private toolEditBypass: Record<string, boolean> = {};
  @state() private toolEditPrompts: ToolEditApprovalPrompt[] = [];
  @state() private bashPrompts: BashApprovalPrompt[] = [];
  @state() private retryPrompts: RetryRequestPrompt[] = [];
  @state() private proposalPrompts: AgentProposalPrompt[] = [];

  private streamStates = new Map<StreamTabId, StreamState>();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.handleMessage);
    postMessage({ command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY });
  }

  disconnectedCallback(): void {
    window.removeEventListener('message', this.handleMessage);
    super.disconnectedCallback();
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const message = event.data;
    if (!message?.command) return;

    switch (message.command) {
      case PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS: {
        const parsed = UpdateStreamsMessageSchema.safeParse(message);
        if (!parsed.success) return;
        this.streams = parsed.data.streams;
        this.activeStreamId = parsed.data.activeStream;
        this.streamFilter = parsed.data.agentFilter;
        this.activeStatus =
          this.streams.find((s) => s.name === this.activeStreamId)?.status ??
          this.activeStatus;
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_LOGS: {
        const parsed = UpdateLogsMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const target = parsed.data.stream;
        const state = this.ensureStreamState(target);

        if (parsed.data.action === 'clear') {
          state.logs = [];
          state.groups = [];
          state.outputFilesByRun = {};
          state.missingOutputsByRun = {};
          state.runInstructions = {};
          state.usageByRun = {};
          state.contextState = null;
          state.instruction = null;
        } else {
          state.logs = parsed.data.messages;
          state.groups = parsed.data.groups;
        }

        if (parsed.data.runInstructions) {
          state.runInstructions = parsed.data.runInstructions;
        }

        if (parsed.data.activeRunId !== undefined) {
          state.activeRunId = parsed.data.activeRunId ?? null;
        }

        if (parsed.data.runUsage) {
          state.usageByRun = parsed.data.runUsage;
        }

        if (parsed.data.runFiles) {
          state.outputFilesByRun = parsed.data.runFiles;
        }

        if (parsed.data.runMissingOutputs) {
          state.missingOutputsByRun = parsed.data.runMissingOutputs;
        }

        if (parsed.data.contextState) {
          state.contextState = parsed.data.contextState;
        }

        this.touchStreamState(target, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.APPEND_LOG: {
        const parsed = AppendLogMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.logs = [...state.logs, parsed.data.logMessage];
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_LOG: {
        const parsed = UpdateLogMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.logs = state.logs.map((entry) =>
          entry.id === parsed.data.logMessage.id
            ? parsed.data.logMessage
            : entry,
        );
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_STATUS: {
        const parsed = UpdateStatusMessageSchema.safeParse(message);
        if (!parsed.success) return;
        this.activeStatus = parsed.data.status;
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS: {
        const parsed = UpdateStreamStatusMessageSchema.safeParse(message);
        if (!parsed.success) return;
        this.streams = this.streams.map((stream) =>
          stream.name === parsed.data.stream
            ? { ...stream, status: parsed.data.status }
            : stream,
        );
        if (this.activeStreamId === parsed.data.stream) {
          this.activeStatus = parsed.data.status;
        }
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_USAGE: {
        const parsed = UpdateUsageMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const target = parsed.data.stream ?? this.activeStreamId;
        if (!target) return;
        const state = this.ensureStreamState(target);
        state.usageByRun = parsed.data.usageByRun;
        this.touchStreamState(target, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE: {
        const parsed = UpdateRunUsageMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.usageByRun = {
          ...state.usageByRun,
          [parsed.data.runId]: parsed.data.usage,
        };
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE: {
        const parsed = UpdateContextStateMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.contextState = parsed.data.contextState;
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION: {
        const parsed = UpdateInstructionMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const target =
          parsed.data.stream === '' ? this.activeStreamId : parsed.data.stream;
        if (!target) return;
        const state = this.ensureStreamState(target);
        state.instruction = parsed.data.instruction;
        this.touchStreamState(target, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_FILES: {
        const parsed = UpdateFilesMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        const runId = parsed.data.runId ?? state.activeRunId ?? 'default';
        const existing = parsed.data.reset ? {} : state.outputFilesByRun;
        state.outputFilesByRun = {
          ...existing,
          [runId]: parsed.data.rounds ?? existing[runId] ?? {},
        };
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS: {
        const parsed = UpdateMissingOutputsMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        const runId = parsed.data.runId ?? state.activeRunId ?? 'default';
        const existing = parsed.data.reset ? {} : state.missingOutputsByRun;
        state.missingOutputsByRun = {
          ...existing,
          [runId]: parsed.data.rounds ?? existing[runId] ?? {},
        };
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_TODOS: {
        const parsed = UpdateTodosMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.todos = parsed.data.todos;
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS: {
        const parsed = UpdateQueuedFollowUpsMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.queuedFollowUps = parsed.data.messages;
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP: {
        const parsed = AddTaskGroupMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const state = this.ensureStreamState(parsed.data.stream);
        state.groups = [...state.groups, parsed.data.group];
        this.touchStreamState(parsed.data.stream, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP: {
        const parsed = UpdateTaskGroupMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const update = parsed.data.update;
        const state = this.ensureStreamState(update.streamId);
        state.groups = state.groups.map((group) =>
          group.id === update.id ? { ...group, ...update } : group,
        );
        this.touchStreamState(update.streamId, state);
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL: {
        const parsed = ShowToolEditApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.toolEditPrompts = [...this.toolEditPrompts, parsed.data.request];
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL: {
        const parsed = ResolveToolEditApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.toolEditPrompts = this.toolEditPrompts.filter(
          (request) => request.requestId !== parsed.data.requestId,
        );
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE: {
        const parsed = UpdateToolEditApprovalStateSchema.safeParse(message);
        if (!parsed.success) return;
        this.toolEditBypass = {
          ...this.toolEditBypass,
          [parsed.data.stream]: parsed.data.bypassActive,
        };
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL: {
        const parsed = ShowBashApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.bashPrompts = [...this.bashPrompts, parsed.data.request];
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL: {
        const parsed = ResolveBashApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.bashPrompts = this.bashPrompts.filter(
          (request) => request.requestId !== parsed.data.requestId,
        );
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST: {
        const parsed = ShowRetryRequestSchema.safeParse(message);
        if (!parsed.success) return;
        this.retryPrompts = [...this.retryPrompts, parsed.data.request];
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST: {
        const parsed = ResolveRetryRequestSchema.safeParse(message);
        if (!parsed.success) return;
        this.retryPrompts = this.retryPrompts.filter(
          (request) => request.streamId !== parsed.data.streamId,
        );
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL: {
        const parsed = ShowAgentProposalSchema.safeParse(message);
        if (!parsed.success) return;
        this.proposalPrompts = [...this.proposalPrompts, parsed.data.proposal];
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL: {
        const parsed = ResolveAgentProposalSchema.safeParse(message);
        if (!parsed.success) return;
        this.proposalPrompts = this.proposalPrompts.filter(
          (proposal) => proposal.proposalId !== parsed.data.proposalId,
        );
        break;
      }
      default: {
        EmptyMessageSchema.safeParse(message);
      }
    }
  };

  private ensureStreamState(streamId: StreamTabId): StreamState {
    const state = this.streamStates.get(streamId) ?? createEmptyStreamState();
    this.streamStates.set(streamId, state);
    return state;
  }

  private touchStreamState(streamId: StreamTabId, state: StreamState): void {
    this.streamStates.set(streamId, state);
    this.requestUpdate();
    if (this.activeStreamId === streamId) {
      this.requestUpdate('activeStreamId');
    }
  }

  private get activeStream(): StreamTabInfo | undefined {
    if (!this.activeStreamId) return undefined;
    return this.streams.find((stream) => stream.name === this.activeStreamId);
  }

  private get activeStreamState(): StreamState | undefined {
    if (!this.activeStreamId) return undefined;
    return this.streamStates.get(this.activeStreamId);
  }

  private postCommand(
    command: string,
    payload: Record<string, unknown> = {},
  ): void {
    postMessage({ command, ...payload });
  }

  private handleStreamClick(streamId: StreamTabId): void {
    this.postCommand(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, {
      stream: streamId,
    });
  }

  private handleStreamDelete(streamId: StreamTabId): void {
    this.postCommand(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, {
      stream: streamId,
    });
  }

  private handleStreamStop(): void {
    if (!this.activeStreamId) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.STOP_STREAM, {
      stream: this.activeStreamId,
    });
  }

  private handleStreamAction(command: string): void {
    if (!this.activeStreamId) return;
    this.postCommand(command, { stream: this.activeStreamId });
  }

  private handleFilterChange(filter: AgentCategoryFilter): void {
    this.postCommand(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, { filter });
  }

  private handleSortChange(sortBy: 'time' | 'inputFile' | 'agent'): void {
    this.postCommand(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, { sortBy });
  }

  private handleFollowUpSend(): void {
    const input =
      this.renderRoot.querySelector<HTMLTextAreaElement>('#followup-input');
    if (!input || !this.activeStreamId) return;
    const text = input.value.trim();
    if (!text) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
      stream: this.activeStreamId,
      text,
    });
    input.value = '';
  }

  private handleFollowUpPolish(): void {
    const input =
      this.renderRoot.querySelector<HTMLTextAreaElement>('#followup-input');
    if (!input || !this.activeStreamId) return;
    const text = input.value.trim();
    if (!text) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
      stream: this.activeStreamId,
      text,
    });
  }

  private handleToolEditBypassToggle(): void {
    if (!this.activeStreamId) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS, {
      stream: this.activeStreamId,
    });
  }

  private handlePromptAction(
    command: string,
    payload: Record<string, unknown>,
  ): void {
    this.postCommand(command, payload);
  }

  private handleFileOpen(file: OutputFileInfo): void {
    const filePath = file.location.absolutePath;
    if (!filePath) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.OPEN_FILE, { file: filePath });
  }

  private handleFileCompareOriginal(file: OutputFileInfo): void {
    const filePath = file.location.absolutePath;
    const base = file.lineage?.original?.absolutePath;
    if (!filePath) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL, {
      file: filePath,
      base,
    });
  }

  private handleFileComparePrevious(file: OutputFileInfo): void {
    const filePath = file.location.absolutePath;
    const base = file.lineage?.original?.absolutePath;
    const prev = file.lineage?.diffBase?.absolutePath;
    if (!filePath) return;
    this.postCommand(PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS, {
      file: filePath,
      base,
      prev,
    });
  }

  private formatFileLocation(file: OutputFileInfo): string {
    const location = file.location;
    if (location.kind === 'workspace' || location.kind === 'runStorage') {
      return location.relativePath || location.absolutePath;
    }
    return location.absolutePath;
  }

  private renderStreamTabs(): TemplateResult {
    if (!this.streams.length) {
      return html`<div class="empty-state">No active streams yet.</div>`;
    }

    return html`
      <div class="stream-tabs">
        ${this.streams.map((stream) => {
          const isActive = stream.name === this.activeStreamId;
          return html`
            <button
              class=${classMap({ 'stream-tab': true, active: isActive })}
              @click=${() => this.handleStreamClick(stream.name)}
            >
              <span>${stream.label}</span>
              ${stream.status ? html`<small>${stream.status}</small>` : null}
            </button>
            <button
              class="ghost"
              title="Delete stream"
              @click=${(event: Event) => {
                event.stopPropagation();
                this.handleStreamDelete(stream.name);
              }}
            >
              Remove
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderToolbar(): TemplateResult {
    const active = this.activeStream;
    if (!active) {
      return html`<div class="toolbar"></div>`;
    }

    const isWorkflow = active.agentCategory === AgentCategory.Workflow;

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
          ${this.toolEditBypass[this.activeStreamId ?? '']
            ? 'Disable YOLO'
            : 'Enable YOLO'}
        </button>
      </div>
    `;
  }

  private renderInstruction(): TemplateResult {
    const state = this.activeStreamState;
    const instruction =
      state?.instruction ??
      (state?.activeRunId
        ? state.runInstructions[state.activeRunId]
        : undefined) ??
      Object.values(state?.runInstructions ?? {}).at(-1);
    if (!instruction) {
      return html``;
    }

    return html`
      <div class="panel">
        <h3>Instruction</h3>
        <div>${instruction.text}</div>
      </div>
    `;
  }

  private renderLogs(): TemplateResult {
    const logs = this.activeStreamState?.logs ?? [];
    if (!logs.length) {
      return html`<div class="empty-state">No logs yet.</div>`;
    }

    return html`
      ${logs.map(
        (log) => html`
          <div class="log-entry">
            <div class="log-entry__meta">
              ${log.level.toUpperCase()} •
              ${new Date(log.timestamp).toLocaleTimeString()}
              ${log.messageType ? html` • ${log.messageType}` : null}
            </div>
            <div>${log.text}</div>
          </div>
        `,
      )}
    `;
  }

  private renderTaskGroups(): TemplateResult {
    const groups = this.activeStreamState?.groups ?? [];
    if (!groups.length) {
      return html`<div class="empty-state">No task groups yet.</div>`;
    }

    return html`
      ${groups.map(
        (group) => html`
          <div class="log-entry">
            <div class="log-entry__meta">${group.status}</div>
            <div>${group.name}</div>
          </div>
        `,
      )}
    `;
  }

  private renderTodos(): TemplateResult {
    const todos = this.activeStreamState?.todos ?? [];
    if (!todos.length) {
      return html`<div class="empty-state">No todos yet.</div>`;
    }

    return html`
      <div class="todo-list">
        ${todos.map(
          (todo) => html`
            <div class="todo-item">
              <span>${todo.content}</span>
              <span>${todo.status}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderOutputFiles(): TemplateResult {
    const state = this.activeStreamState;
    if (!state) {
      return html`<div class="empty-state">No files yet.</div>`;
    }

    const runId =
      state.activeRunId ?? Object.keys(state.outputFilesByRun).at(-1) ?? null;
    if (!runId) {
      return html`<div class="empty-state">No files yet.</div>`;
    }

    const rounds = state.outputFilesByRun[runId] ?? {};
    const roundEntries = Object.entries(rounds).sort(
      ([a], [b]) => Number(a) - Number(b),
    );
    const missingRounds = state.missingOutputsByRun[runId] ?? {};
    const missingEntries = Object.entries(missingRounds).sort(
      ([a], [b]) => Number(a) - Number(b),
    );

    if (!roundEntries.length) {
      return html`<div class="empty-state">No files yet.</div>`;
    }

    return html`
      ${roundEntries.map(
        ([round, files]) => html`
          <div>
            <div class="log-entry__meta">Round ${round}</div>
            ${files.map(
              (file) => html`
                <div class="file-entry">
                  <strong>${this.formatFileLocation(file)}</strong>
                  <div class="file-actions">
                    <button
                      class="secondary"
                      @click=${() => this.handleFileOpen(file)}
                    >
                      Open
                    </button>
                    <button
                      class="ghost"
                      @click=${() => this.handleFileCompareOriginal(file)}
                    >
                      Compare Original
                    </button>
                    <button
                      class="ghost"
                      @click=${() => this.handleFileComparePrevious(file)}
                    >
                      Compare Previous
                    </button>
                  </div>
                </div>
              `,
            )}
          </div>
        `,
      )}
      ${missingEntries.length
        ? html`
            <div>
              <div class="log-entry__meta">Missing outputs</div>
              ${missingEntries.map(
                ([round, files]) => html`
                  <div class="file-entry">
                    <div>Round ${round}</div>
                    <div>${files.join(', ')}</div>
                  </div>
                `,
              )}
            </div>
          `
        : null}
    `;
  }

  private renderUsage(): TemplateResult {
    const usageByRun = this.activeStreamState?.usageByRun ?? {};
    const entries = Object.entries(usageByRun);
    if (!entries.length) {
      return html`<div class="empty-state">No usage yet.</div>`;
    }

    return html`
      ${entries.map(
        ([runId, usage]) => html`
          <div class="log-entry">
            <div class="log-entry__meta">Run ${runId}</div>
            <div>
              Input: ${usage.inputTokens} • Output: ${usage.outputTokens} •
              Cost: $${usage.cost.toFixed(4)}
            </div>
          </div>
        `,
      )}
    `;
  }

  private renderContextState(): TemplateResult {
    const context = this.activeStreamState?.contextState;
    if (!context) return html``;
    return html`
      <div class="log-entry">
        <div class="log-entry__meta">Context</div>
        <div>
          ${context.utilizationPercent.toFixed(1)}% used •
          ${context.inputTokens} / ${context.contextWindow} tokens
        </div>
      </div>
    `;
  }

  private renderFollowUpInput(): TemplateResult {
    if (!this.activeStream) {
      return html``;
    }

    const queued = this.activeStreamState?.queuedFollowUps ?? [];

    return html`
      <div class="panel">
        <h3>Follow-up</h3>
        <textarea
          id="followup-input"
          placeholder="Send a follow-up..."
        ></textarea>
        <div class="toolbar">
          <button class="secondary" @click=${this.handleFollowUpSend}>
            Send
          </button>
          <button class="ghost" @click=${this.handleFollowUpPolish}>
            Polish
          </button>
        </div>
        ${queued.length
          ? html`
              <div>
                <div class="log-entry__meta">Queued follow-ups</div>
                <ul>
                  ${queued.map((item) => html`<li>${item}</li>`)}
                </ul>
              </div>
            `
          : null}
      </div>
    `;
  }

  private renderPromptOverlay(): TemplateResult {
    const hasPrompts =
      this.toolEditPrompts.length ||
      this.bashPrompts.length ||
      this.retryPrompts.length ||
      this.proposalPrompts.length;

    if (!hasPrompts) {
      return html``;
    }

    return html`
      <div class="prompt-overlay">
        <div class="prompt-card">
          <h3>Pending approvals</h3>
          <div class="prompt-list">
            ${this.toolEditPrompts.map((prompt) =>
              this.renderToolEditPrompt(prompt),
            )}
            ${this.bashPrompts.map((prompt) => this.renderBashPrompt(prompt))}
            ${this.retryPrompts.map((prompt) => this.renderRetryPrompt(prompt))}
            ${this.proposalPrompts.map((prompt) =>
              this.renderProposalPrompt(prompt),
            )}
          </div>
        </div>
      </div>
    `;
  }

  private renderToolEditPrompt(prompt: ToolEditApprovalPrompt): TemplateResult {
    return html`
      <div class="panel">
        <strong>Tool edit</strong>
        <div>${prompt.relativePath}</div>
        <div>+${prompt.addedLines} / -${prompt.removedLines}</div>
        <div class="toolbar">
          <button
            class="secondary"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
                { requestId: prompt.requestId, action: 'approve' },
              )}
          >
            Approve
          </button>
          <button
            class="ghost"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
                { requestId: prompt.requestId, action: 'reject' },
              )}
          >
            Reject
          </button>
        </div>
      </div>
    `;
  }

  private renderBashPrompt(prompt: BashApprovalPrompt): TemplateResult {
    return html`
      <div class="panel">
        <strong>Command approval</strong>
        <div>${prompt.command}</div>
        <div class="toolbar">
          <button
            class="secondary"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
                { requestId: prompt.requestId, action: 'approve' },
              )}
          >
            Approve
          </button>
          <button
            class="ghost"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
                { requestId: prompt.requestId, action: 'reject' },
              )}
          >
            Reject
          </button>
        </div>
      </div>
    `;
  }

  private renderRetryPrompt(prompt: RetryRequestPrompt): TemplateResult {
    return html`
      <div class="panel">
        <strong>Retry request</strong>
        <div>${prompt.operation}</div>
        ${prompt.errorMessage ? html`<div>${prompt.errorMessage}</div>` : null}
        <div class="toolbar">
          <button
            class="secondary"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
                {
                  stream: prompt.streamId,
                },
              )}
          >
            Retry
          </button>
          <button
            class="ghost"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST,
                { stream: prompt.streamId },
              )}
          >
            Dismiss
          </button>
        </div>
      </div>
    `;
  }

  private renderProposalPrompt(prompt: AgentProposalPrompt): TemplateResult {
    return html`
      <div class="panel">
        <strong>Agent proposal</strong>
        <div>${prompt.agent}</div>
        <div class="toolbar">
          <button
            class="secondary"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
                { proposalId: prompt.proposalId, action: 'approve' },
              )}
          >
            Approve
          </button>
          <button
            class="ghost"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
                { proposalId: prompt.proposalId, action: 'setup' },
              )}
          >
            Setup
          </button>
          <button
            class="ghost"
            @click=${() =>
              this.handlePromptAction(
                PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
                { proposalId: prompt.proposalId, action: 'reject' },
              )}
          >
            Reject
          </button>
        </div>
      </div>
    `;
  }

  private renderFilters(): TemplateResult {
    return html`
      <div class="toolbar">
        <button
          class=${classMap({ secondary: this.streamFilter === 'all' })}
          @click=${() => this.handleFilterChange('all')}
        >
          All
        </button>
        <button
          class=${classMap({ secondary: this.streamFilter === 'workflow' })}
          @click=${() => this.handleFilterChange(AgentCategory.Workflow)}
        >
          Workflow
        </button>
        <button
          class=${classMap({ secondary: this.streamFilter === 'toolUse' })}
          @click=${() => this.handleFilterChange(AgentCategory.ToolUse)}
        >
          Tool Use
        </button>
        <button class="ghost" @click=${() => this.handleSortChange('time')}>
          Sort: Time
        </button>
        <button class="ghost" @click=${() => this.handleSortChange('agent')}>
          Sort: Agent
        </button>
        <button
          class="ghost"
          @click=${() => this.handleSortChange('inputFile')}
        >
          Sort: Input
        </button>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <div class="main-container">
        <div class="header">
          <div class="header-row">
            ${this.renderStreamTabs()}
            <span class="status-pill">${this.activeStatus}</span>
          </div>
          ${this.renderFilters()} ${this.renderToolbar()}
        </div>

        ${this.renderPromptOverlay()} ${this.renderInstruction()}

        <div class="content">
          <div class="panel">
            <h3>Logs</h3>
            ${this.renderLogs()}
          </div>
          <div class="panel">
            <h3>Task Groups</h3>
            ${this.renderTaskGroups()}
          </div>
          <div class="panel">
            <h3>Output Files</h3>
            ${this.renderOutputFiles()}
          </div>
          <div class="panel">
            <h3>Todos</h3>
            ${this.renderTodos()}
          </div>
          <div class="panel">
            <h3>Usage</h3>
            ${this.renderUsage()} ${this.renderContextState()}
          </div>
        </div>

        ${this.renderFollowUpInput()}
      </div>
    `;
  }
}
