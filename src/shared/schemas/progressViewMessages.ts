/**
 * Progress View Message Schemas
 *
 * Shared message envelope schemas for communication between
 * backend (WebviewUpdater) and frontend (ProgressApp).
 *
 * These schemas compose existing data schemas from this directory
 * and add the command discriminator for type-safe dispatch.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas (data types)
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
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
} from './index';
import {
  AgentOptionDataSchema,
  ModelOptionDataSchema,
} from './mainViewMessages';

// Local imports - command constants

// ============================================================================
// Shared Field Schemas
// ============================================================================

/** Agent category filter - 'all' or specific category */
export const AgentCategoryFilterSchema = z.union([
  z.literal('all'),
  AgentCategorySchema,
]);
export type AgentCategoryFilter = z.infer<typeof AgentCategoryFilterSchema>;

/** Context window utilization state */
export const ContextStateSchema = z.object({
  inputTokens: z.number(),
  contextWindow: z.number(),
  utilizationPercent: z.number(),
});
export type ContextState = z.infer<typeof ContextStateSchema>;

// ============================================================================
// Backend → Frontend Messages (Outbound)
// ============================================================================

// --- Stream Management ---

export const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
  agentFilter: AgentCategoryFilterSchema,
  /** Full stream states keyed by stream ID - backend is source of truth */
  streamStates: z.record(z.string(), z.unknown()).optional(),
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

// --- Log Messages ---

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

// --- Files ---

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

// --- Instruction ---

export const UpdateInstructionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION),
  stream: z.union([StreamTabIdSchema, z.literal('')]),
  instruction: InstructionUpdateSchema.nullable(),
  agentCategory: z.string().optional(),
});

// --- Task Groups ---

export const AddTaskGroupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP),
  stream: StreamTabIdSchema,
  group: TaskGroupSchema,
});

export const UpdateTaskGroupMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP),
  update: UpdateTaskGroupPayloadSchema,
});

// --- Todos ---

export const UpdateTodosMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  stream: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});

// --- Usage ---

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

// --- Queued Follow-ups ---

export const UpdateQueuedFollowUpsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
  stream: StreamTabIdSchema,
  messages: z.array(z.string()),
});

// --- Tool Edit Approval ---

export const ShowToolEditApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL),
  request: ToolEditApprovalPromptSchema,
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

// --- Bash Approval ---

export const ShowBashApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL),
  request: BashApprovalPromptSchema,
});

export const ResolveBashApprovalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL),
  requestId: z.string(),
});

// --- Retry Request ---

export const ShowRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST),
  request: RetryRequestPromptSchema,
});

export const ResolveRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST),
  streamId: StreamTabIdSchema,
});

// --- Agent Proposal ---

export const ShowAgentProposalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL),
  proposal: AgentProposalPromptSchema,
});

export const ResolveAgentProposalMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL),
  proposalId: z.string(),
});

// --- Follow-up Text ---

export const FollowUpTextPolishedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED),
  text: z.string(),
});

export const FollowUpTextTranscribedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED),
  text: z.string(),
});

// --- Recording ---

export const RecordingStartedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_STARTED),
});

export const RecordingStoppedMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED),
});

export const RecordingErrorMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RECORDING_ERROR),
});

// --- Followup Options ---

export const SetFollowupOptionsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS),
  // Legacy HTML options (deprecated - use typed data instead)
  workflowAgentsHtml: z.string().optional(),
  toolUseAgentsHtml: z.string().optional(),
  modelOptionsHtml: z.string().optional(),
  // Typed data options (Lit-native)
  workflowAgentsData: z.array(AgentOptionDataSchema).optional(),
  toolUseAgentsData: z.array(AgentOptionDataSchema).optional(),
  modelOptionsData: z.array(ModelOptionDataSchema).optional(),
  defaultMergeModel: z.string().optional(),
});

// --- Theme ---

export const SetThemeMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: z.enum(['dark', 'light']),
});

// --- Stream Deletion (extension host → frontend) ---

export const DeleteStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
  stream: StreamTabIdSchema,
});

export const DeleteAllMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_ALL),
});

// ============================================================================
// Discriminated Union for Type-Safe Dispatch
// ============================================================================

/**
 * All backend → frontend messages for the progress view.
 * Use this for parsing incoming messages with full type narrowing.
 */
export const ProgressViewOutboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Stream management
    UpdateStreamsMessageSchema,
    UpdateStreamStatusMessageSchema,
    UpdateStatusMessageSchema,
    // Logs
    UpdateLogsMessageSchema,
    AppendLogMessageSchema,
    UpdateLogMessageSchema,
    // Files
    UpdateFilesMessageSchema,
    UpdateMissingOutputsMessageSchema,
    // Instruction
    UpdateInstructionMessageSchema,
    // Task groups
    AddTaskGroupMessageSchema,
    UpdateTaskGroupMessageSchema,
    // Todos
    UpdateTodosMessageSchema,
    // Usage
    UpdateUsageMessageSchema,
    UpdateRunUsageMessageSchema,
    UpdateContextStateMessageSchema,
    // Queued follow-ups
    UpdateQueuedFollowUpsMessageSchema,
    // Tool edit approval
    ShowToolEditApprovalMessageSchema,
    ResolveToolEditApprovalMessageSchema,
    UpdateToolEditApprovalStateMessageSchema,
    // Bash approval
    ShowBashApprovalMessageSchema,
    ResolveBashApprovalMessageSchema,
    // Retry request
    ShowRetryRequestMessageSchema,
    ResolveRetryRequestMessageSchema,
    // Agent proposal
    ShowAgentProposalMessageSchema,
    ResolveAgentProposalMessageSchema,
    // Follow-up text
    FollowUpTextPolishedMessageSchema,
    FollowUpTextTranscribedMessageSchema,
    // Recording
    RecordingStartedMessageSchema,
    RecordingStoppedMessageSchema,
    RecordingErrorMessageSchema,
    // Followup options
    SetFollowupOptionsMessageSchema,
    // Theme
    SetThemeMessageSchema,
    // Stream deletion
    DeleteStreamMessageSchema,
    DeleteAllMessageSchema,
  ],
);

export type ProgressViewOutboundMessage = z.infer<
  typeof ProgressViewOutboundMessageSchema
>;

// ============================================================================
// Type Exports for Individual Messages
// ============================================================================

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
