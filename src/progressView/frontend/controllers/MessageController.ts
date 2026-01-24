// Third-party imports
import type { ReactiveController, ReactiveControllerHost } from 'lit';
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
  type RetryRequestPrompt,
  type StreamStatus,
  type StreamTabId,
  type StreamTabInfo,
  type ToolEditApprovalPrompt,
} from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view types
import { InstructionUpdateSchema } from '@progressView/types';

// Local imports - agent types
import { AgentCategory } from '@shared/schemas';
import type { AgentCategoryFilter } from '@agent/types/AgentStreamTypes';

// Local imports - progress view state
import { createEmptyStreamState, type StreamState } from '../state/streamState';

// Local imports - webview API
import { postMessage } from '../vscode';

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

interface MessageControllerState {
  streams: StreamTabInfo[];
  activeStreamId: StreamTabId | null;
  activeStatus: StreamStatus;
  streamFilter: AgentCategoryFilter;
  toolEditBypass: Record<string, boolean>;
  toolEditPrompts: ToolEditApprovalPrompt[];
  bashPrompts: BashApprovalPrompt[];
  retryPrompts: RetryRequestPrompt[];
  proposalPrompts: AgentProposalPrompt[];
}

/**
 * Manages ProgressView message handling and state updates.
 */
export class MessageController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private readonly onStateChange: () => void;

  private state: MessageControllerState = {
    streams: [],
    activeStreamId: null,
    activeStatus: STREAM_STATUS.READY,
    streamFilter: 'all',
    toolEditBypass: {},
    toolEditPrompts: [],
    bashPrompts: [],
    retryPrompts: [],
    proposalPrompts: [],
  };

  private streamStates = new Map<StreamTabId, StreamState>();

  constructor(host: ReactiveControllerHost, onStateChange: () => void) {
    this.host = host;
    this.onStateChange = onStateChange;
    host.addController(this);
  }

  hostConnected(): void {
    window.addEventListener('message', this.handleMessage);
    postMessage({ command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY });
  }

  hostDisconnected(): void {
    window.removeEventListener('message', this.handleMessage);
  }

  get streams(): StreamTabInfo[] {
    return this.state.streams;
  }

  get activeStreamId(): StreamTabId | null {
    return this.state.activeStreamId;
  }

  get activeStatus(): StreamStatus {
    return this.state.activeStatus;
  }

  get streamFilter(): AgentCategoryFilter {
    return this.state.streamFilter;
  }

  get toolEditBypass(): Record<string, boolean> {
    return this.state.toolEditBypass;
  }

  get toolEditPrompts(): ToolEditApprovalPrompt[] {
    return this.state.toolEditPrompts;
  }

  get bashPrompts(): BashApprovalPrompt[] {
    return this.state.bashPrompts;
  }

  get retryPrompts(): RetryRequestPrompt[] {
    return this.state.retryPrompts;
  }

  get proposalPrompts(): AgentProposalPrompt[] {
    return this.state.proposalPrompts;
  }

  getActiveStream(): StreamTabInfo | undefined {
    if (!this.state.activeStreamId) return undefined;
    return this.state.streams.find(
      (stream) => stream.name === this.state.activeStreamId,
    );
  }

  getActiveStreamState(): StreamState | undefined {
    if (!this.state.activeStreamId) return undefined;
    return this.streamStates.get(this.state.activeStreamId);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const message = event.data;
    if (!message?.command) return;

    switch (message.command) {
      case PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS: {
        const parsed = UpdateStreamsMessageSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          streams: parsed.data.streams,
          activeStreamId: parsed.data.activeStream,
          streamFilter: parsed.data.agentFilter,
          activeStatus:
            parsed.data.streams.find(
              (stream) => stream.name === parsed.data.activeStream,
            )?.status ?? this.state.activeStatus,
        };
        this.notify();
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
        this.state = { ...this.state, activeStatus: parsed.data.status };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS: {
        const parsed = UpdateStreamStatusMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const nextStreams = this.state.streams.map((stream) =>
          stream.name === parsed.data.stream
            ? { ...stream, status: parsed.data.status }
            : stream,
        );
        this.state = {
          ...this.state,
          streams: nextStreams,
          activeStatus:
            this.state.activeStreamId === parsed.data.stream
              ? parsed.data.status
              : this.state.activeStatus,
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_USAGE: {
        const parsed = UpdateUsageMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const target = parsed.data.stream ?? this.state.activeStreamId;
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
          parsed.data.stream === ''
            ? this.state.activeStreamId
            : parsed.data.stream;
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
        this.state = {
          ...this.state,
          toolEditPrompts: [...this.state.toolEditPrompts, parsed.data.request],
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL: {
        const parsed = ResolveToolEditApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          toolEditPrompts: this.state.toolEditPrompts.filter(
            (request) => request.requestId !== parsed.data.requestId,
          ),
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE: {
        const parsed = UpdateToolEditApprovalStateSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          toolEditBypass: {
            ...this.state.toolEditBypass,
            [parsed.data.stream]: parsed.data.bypassActive,
          },
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL: {
        const parsed = ShowBashApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          bashPrompts: [...this.state.bashPrompts, parsed.data.request],
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL: {
        const parsed = ResolveBashApprovalSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          bashPrompts: this.state.bashPrompts.filter(
            (request) => request.requestId !== parsed.data.requestId,
          ),
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST: {
        const parsed = ShowRetryRequestSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          retryPrompts: [...this.state.retryPrompts, parsed.data.request],
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST: {
        const parsed = ResolveRetryRequestSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          retryPrompts: this.state.retryPrompts.filter(
            (request) => request.streamId !== parsed.data.streamId,
          ),
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL: {
        const parsed = ShowAgentProposalSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          proposalPrompts: [
            ...this.state.proposalPrompts,
            parsed.data.proposal,
          ],
        };
        this.notify();
        break;
      }
      case PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL: {
        const parsed = ResolveAgentProposalSchema.safeParse(message);
        if (!parsed.success) return;
        this.state = {
          ...this.state,
          proposalPrompts: this.state.proposalPrompts.filter(
            (proposal) => proposal.proposalId !== parsed.data.proposalId,
          ),
        };
        this.notify();
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
    this.notify();
    if (this.state.activeStreamId === streamId) {
      this.host.requestUpdate();
    }
  }

  private notify(): void {
    this.host.requestUpdate();
    this.onStateChange();
  }
}
