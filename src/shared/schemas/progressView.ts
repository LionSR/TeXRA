/**
 * ProgressView schemas - messages and data.
 *
 * Outbound: Backend -> Frontend (UPDATE_*, SHOW_*, RESOLVE_*)
 * Inbound: Frontend -> Backend (SWITCH_STREAM, SEND_FOLLOW_UP, etc.)
 */
import { z } from 'zod';

import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import { AgentCategorySchema } from './agent';
import { StreamTabIdSchema } from './identifiers';
import { LogMessageDataSchema } from './log';
import { AgentOptionDataSchema, ModelOptionDataSchema } from './mainView';
import { OutputFileInfoSchema } from './output';
import {
  AgentProposalPermissionSchema,
  BashPermissionSchema,
  RetryPermissionSchema,
  ToolEditPermissionSchema,
} from './prompts';
import {
  InstructionUpdateSchema,
  StreamStatusSchema,
  StreamTabInfoSchema,
} from './stream';
import { StreamStateSchema } from './streamState';
import { TaskGroupSchema, UpdateTaskGroupPayloadSchema } from './taskGroup';
import { TodoItemSchema } from './todo';
import { ContextStateSchema, TokenUsageStatsSchema } from './usage';

// ============================================================
// Shared Field Schemas
// ============================================================

export const AgentCategoryFilterSchema = z.union([
  z.literal('all'),
  AgentCategorySchema,
]);
export type AgentCategoryFilter = z.infer<typeof AgentCategoryFilterSchema>;

// ============================================================
// Progress View Data Schemas
// ============================================================

export const MissingOutputsPayloadSchema = z.object({
  missing: z.array(z.string()).prefault([]),
  xmlFile: z.string().nullable().prefault(null),
  documentTag: z.string().nullable().prefault(null),
});
export type MissingOutputsPayload = z.infer<typeof MissingOutputsPayloadSchema>;

export const ToolUseLogSchema = z.object({
  toolName: z.string().optional(),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  isError: z.boolean().optional(),
  userInstruction: z.string().optional(),
});
export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

export const NormalizedToolUseSchema = z.object({
  parsed: z.record(z.string(), z.unknown()),
  toolName: z.string(),
  errorText: z.string(),
  outputText: z.string(),
  userInstructionText: z.string(),
  input: z.unknown(),
  isError: z.boolean(),
  isUserFeedback: z.boolean(),
  headerSummary: z.string(),
});
export type NormalizedToolUse = z.infer<typeof NormalizedToolUseSchema>;

export const WebSearchResultSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  domain: z.string().optional(),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchPayloadSchema = z.object({
  query: z.string().optional(),
  results: z.array(WebSearchResultSchema).optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
});
export type WebSearchPayload = z.infer<typeof WebSearchPayloadSchema>;

// ============================================================
// Outbound Message Schemas (backend -> frontend)
// ============================================================

export const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
  agentFilter: AgentCategoryFilterSchema,
  streamStates: z.record(z.string(), StreamStateSchema).optional(),
});

export const UpdateStreamStatusMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS),
  stream: StreamTabIdSchema,
  status: StreamStatusSchema,
  lastTimestamp: z.number().optional(),
});

export const UpdateStatusMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STATUS),
  status: StreamStatusSchema,
});

export const UpdateLogsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_LOGS),
  stream: z.union([StreamTabIdSchema, z.literal('')]),
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
  contextState: ContextStateSchema.optional(),
});

export const AppendLogMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.APPEND_LOG),
  stream: StreamTabIdSchema,
  logMessage: LogMessageDataSchema,
});

export const UpdateLogMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_LOG),
  stream: StreamTabIdSchema,
  logMessage: LogMessageDataSchema,
});

export const UpdateFilesMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FILES),
  stream: StreamTabIdSchema,
  runId: z.string().optional(),
  rounds: z.record(z.string(), z.array(OutputFileInfoSchema)).optional(),
  reset: z.boolean().optional(),
});

export const UpdateMissingOutputsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS),
  stream: StreamTabIdSchema,
  runId: z.string().optional(),
  rounds: z.record(z.string(), z.array(z.string())).optional(),
  reset: z.boolean().optional(),
});

export const UpdateInstructionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION),
  stream: z.union([StreamTabIdSchema, z.literal('')]),
  instruction: InstructionUpdateSchema.nullable(),
  agentCategory: z.string().optional(),
  runId: z.string().nullish(),
});

export const AddTaskGroupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP),
  stream: StreamTabIdSchema,
  group: TaskGroupSchema,
});

export const UpdateTaskGroupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP),
  update: UpdateTaskGroupPayloadSchema,
});

export const UpdateTodosMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  stream: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});

export const UpdateUsageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_USAGE),
  stream: StreamTabIdSchema,
  usage: z.record(z.string(), TokenUsageStatsSchema),
});

export const UpdateRunUsageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE),
  stream: StreamTabIdSchema,
  runId: z.string(),
  usage: TokenUsageStatsSchema,
});

export const UpdateContextStateMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE),
  stream: StreamTabIdSchema,
  contextState: ContextStateSchema,
});

export const UpdateQueuedFollowUpsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
  stream: StreamTabIdSchema,
  messages: z.array(z.string()),
});

export const ShowToolEditApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL),
  request: ToolEditPermissionSchema,
});

export const ResolveToolEditApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL),
  requestId: z.string(),
});

export const UpdateToolEditApprovalStateMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE),
  stream: StreamTabIdSchema,
  bypassActive: z.boolean(),
});

export const ShowBashApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL),
  request: BashPermissionSchema,
});

export const ResolveBashApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL),
  requestId: z.string(),
});

export const ShowRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST),
  request: RetryPermissionSchema,
});

export const ResolveRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST),
  streamId: StreamTabIdSchema,
});

export const ShowAgentProposalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL),
  proposal: AgentProposalPermissionSchema,
});

export const ResolveAgentProposalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL),
  proposalId: z.string(),
});

export const FollowUpTextPolishedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED),
  text: z.string(),
});

export const FollowUpTextPolishErrorMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISH_ERROR),
  error: z.string().optional(),
});

export const FollowUpTextTranscribedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED),
  text: z.string(),
});

export const ProgressRecordingStartedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_STARTED),
});

export const ProgressRecordingStoppedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED),
});

export const ProgressRecordingErrorMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_ERROR),
});

export const SetFollowupOptionsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS),
  stream: StreamTabIdSchema.nullish(),
  workflowAgentsData: z.array(AgentOptionDataSchema).optional(),
  toolUseAgentsData: z.array(AgentOptionDataSchema).optional(),
  modelOptionsData: z.array(ModelOptionDataSchema).optional(),
  defaultMergeModel: z.string().optional(),
});

export const ProgressSetThemeMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: z.enum(['dark', 'light']),
});

export const ProgressDeleteStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
  stream: StreamTabIdSchema,
});

export const ProgressDeleteAllMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
});

export const ProgressViewOutboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    UpdateStreamsMessageSchema,
    UpdateStreamStatusMessageSchema,
    UpdateStatusMessageSchema,
    UpdateLogsMessageSchema,
    AppendLogMessageSchema,
    UpdateLogMessageSchema,
    UpdateFilesMessageSchema,
    UpdateMissingOutputsMessageSchema,
    UpdateInstructionMessageSchema,
    AddTaskGroupMessageSchema,
    UpdateTaskGroupMessageSchema,
    UpdateTodosMessageSchema,
    UpdateUsageMessageSchema,
    UpdateRunUsageMessageSchema,
    UpdateContextStateMessageSchema,
    UpdateQueuedFollowUpsMessageSchema,
    ShowToolEditApprovalMessageSchema,
    ResolveToolEditApprovalMessageSchema,
    UpdateToolEditApprovalStateMessageSchema,
    ShowBashApprovalMessageSchema,
    ResolveBashApprovalMessageSchema,
    ShowRetryRequestMessageSchema,
    ResolveRetryRequestMessageSchema,
    ShowAgentProposalMessageSchema,
    ResolveAgentProposalMessageSchema,
    FollowUpTextPolishedMessageSchema,
    FollowUpTextPolishErrorMessageSchema,
    FollowUpTextTranscribedMessageSchema,
    ProgressRecordingStartedMessageSchema,
    ProgressRecordingStoppedMessageSchema,
    ProgressRecordingErrorMessageSchema,
    SetFollowupOptionsMessageSchema,
    ProgressSetThemeMessageSchema,
    ProgressDeleteStreamMessageSchema,
    ProgressDeleteAllMessageSchema,
  ],
);

export type ProgressViewOutboundMessage = z.infer<
  typeof ProgressViewOutboundMessageSchema
>;

export type UpdateStreamsMessage = z.infer<typeof UpdateStreamsMessageSchema>;
export type UpdateLogsMessage = z.infer<typeof UpdateLogsMessageSchema>;
export type AppendLogMessage = z.infer<typeof AppendLogMessageSchema>;
export type UpdateLogMessage = z.infer<typeof UpdateLogMessageSchema>;
export type UpdateFilesMessage = z.infer<typeof UpdateFilesMessageSchema>;
export type UpdateInstructionMessage = z.infer<
  typeof UpdateInstructionMessageSchema
>;
export type AddTaskGroupMessage = z.infer<typeof AddTaskGroupMessageSchema>;
export type UpdateTaskGroupMessage = z.infer<
  typeof UpdateTaskGroupMessageSchema
>;
export type UpdateTodosMessage = z.infer<typeof UpdateTodosMessageSchema>;
export type ShowToolEditApprovalMessage = z.infer<
  typeof ShowToolEditApprovalMessageSchema
>;
export type ShowBashApprovalMessage = z.infer<
  typeof ShowBashApprovalMessageSchema
>;
export type ShowRetryRequestMessage = z.infer<
  typeof ShowRetryRequestMessageSchema
>;
export type ShowAgentProposalMessage = z.infer<
  typeof ShowAgentProposalMessageSchema
>;
export type SetFollowupOptionsMessage = z.infer<
  typeof SetFollowupOptionsMessageSchema
>;

// ============================================================
// Inbound Message Schemas (frontend -> backend)
// ============================================================

const TOOL_EDIT_APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'openDiff',
  'showLatexdiff',
  'previewProposed',
] as const;

const BASH_APPROVAL_ACTIONS = ['approve', 'reject'] as const;

const TrimmedStringSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

const WebviewReadyMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.WEBVIEW_READY),
});

const InboundDeleteAllMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
});

const OpenProfileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_PROFILE),
});

const OpenMemoryViewMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_MEMORY_VIEW),
});

const GetFollowupOptionsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS),
  stream: StreamTabIdSchema.nullish(),
});

const StartRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.START_RECORDING),
});

const StopRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_RECORDING),
});

const ThemeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: z.enum(['dark', 'light']),
});

const DebugModeSetMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

const SwitchStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM),
  stream: StreamTabIdSchema,
});

const InboundDeleteStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
  stream: StreamTabIdSchema,
});

const StopStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_STREAM),
  stream: StreamTabIdSchema,
});

const ResumeMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESUME),
  stream: StreamTabIdSchema,
});

const RunNewMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_NEW),
  stream: StreamTabIdSchema,
});

const DiffStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DIFF_STREAM),
  stream: StreamTabIdSchema,
});

const PackStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.PACK_STREAM),
  stream: StreamTabIdSchema,
});

const CleanStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CLEAN_STREAM),
  stream: StreamTabIdSchema,
});

const RestoreStateMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESTORE_STATE),
  stream: StreamTabIdSchema,
});

const OpenTaskStorageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE),
  stream: StreamTabIdSchema,
});

const CancelRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST),
  stream: StreamTabIdSchema,
});

const ToggleToolEditApprovalBypassMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS),
  stream: StreamTabIdSchema,
});

const SendFollowUpMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP),
  stream: StreamTabIdSchema,
  text: TrimmedStringSchema,
});

const PolishFollowUpMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP),
  stream: StreamTabIdSchema,
  text: TrimmedStringSchema,
});

const RetryStreamRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST),
  stream: StreamTabIdSchema,
  feedback: z.string().optional(),
});

const SortStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SORT_STREAMS),
  sortBy: z.enum(['time', 'inputFile', 'agent']).prefault('time'),
});

const FilterStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS),
  filter: z.union([z.literal('all'), AgentCategorySchema]),
});

const ShowInformationMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE),
  text: TrimmedStringSchema,
});

const ToolEditApprovalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION),
  requestId: z.string().min(1),
  action: z.enum(TOOL_EDIT_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

const BashApprovalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION),
  requestId: z.string().min(1),
  action: z.enum(BASH_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

const AgentProposalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION),
  proposalId: z.string().min(1),
  action: z.enum(['approve', 'reject', 'setup']),
  feedback: z.string().optional(),
});

const OpenFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_FILE),
  file: z.string().min(1),
  line: z.int().nonnegative().optional(),
});

const OpenFileCompileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE),
  file: z.string().min(1),
});

const CompareOriginalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const ComparePreviousMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
  prev: z.string().min(1).optional(),
});

const AcceptFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ACCEPT_FILE),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const MergeFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.MERGE_FILE),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const LatexdiffFileMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE),
  file: z.string().min(1),
  base: z.string().min(1).optional(),
});

const OpenLabelMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.OPEN_LABEL),
  label: z.string().min(1),
});

const FollowupConfigSchema = z.object({
  stream: StreamTabIdSchema,
  mode: z.enum(['chat', 'workflow', 'merge']),
  agent: z.string().min(1),
  model: z.string().min(1),
  includeInstruction: z.boolean().optional(),
  initialQuestion: z.string().optional(),
  attachAgentOutputs: z.boolean().optional(),
});

const SetupFollowupMessageSchema = FollowupConfigSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP),
});

const RunFollowupMessageSchema = FollowupConfigSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP),
});

export const ProgressViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    WebviewReadyMessageSchema,
    ThemeSetMessageSchema,
    DebugModeSetMessageSchema,
    SwitchStreamMessageSchema,
    InboundDeleteStreamMessageSchema,
    InboundDeleteAllMessageSchema,
    StopStreamMessageSchema,
    ResumeMessageSchema,
    RunNewMessageSchema,
    DiffStreamMessageSchema,
    PackStreamMessageSchema,
    CleanStreamMessageSchema,
    RestoreStateMessageSchema,
    OpenTaskStorageMessageSchema,
    SortStreamsMessageSchema,
    FilterStreamsMessageSchema,
    SendFollowUpMessageSchema,
    PolishFollowUpMessageSchema,
    RetryStreamRequestMessageSchema,
    CancelRetryRequestMessageSchema,
    StartRecordingMessageSchema,
    StopRecordingMessageSchema,
    ToolEditApprovalActionMessageSchema,
    ToggleToolEditApprovalBypassMessageSchema,
    BashApprovalActionMessageSchema,
    AgentProposalActionMessageSchema,
    ShowInformationMessageSchema,
    OpenProfileMessageSchema,
    OpenMemoryViewMessageSchema,
    OpenFileMessageSchema,
    OpenFileCompileMessageSchema,
    CompareOriginalMessageSchema,
    ComparePreviousMessageSchema,
    AcceptFileMessageSchema,
    MergeFileMessageSchema,
    LatexdiffFileMessageSchema,
    OpenLabelMessageSchema,
    GetFollowupOptionsMessageSchema,
    SetupFollowupMessageSchema,
    RunFollowupMessageSchema,
  ],
);

export type ProgressViewInboundMessage = z.infer<
  typeof ProgressViewInboundMessageSchema
>;

// ============================================================
// Handler Registry and Dispatcher
// ============================================================

export type ProgressViewInboundHandlerRegistry =
  HandlerRegistry<ProgressViewInboundMessage>;

export const dispatchProgressViewInbound = createDispatcher(
  ProgressViewInboundMessageSchema,
);
