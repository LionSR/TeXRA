/**
 * ProgressView schemas - messages and data.
 *
 * Outbound: Backend -> Frontend (UPDATE_*)
 * Inbound: Frontend -> Backend (SWITCH_STREAM, SEND_FOLLOW_UP, etc.)
 */
import { z } from 'zod';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

import { AgentCategorySchema } from './agent';
import { StreamTabIdSchema } from './identifiers';
import { StreamLogEntrySchema } from './log';
import { AgentOptionDataSchema, ModelOptionDataSchema } from './mainView';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import {
  AgentProposalSchema,
  AgentProposalPermissionSchema,
  BashPermissionSchema,
  EXTERNAL_INQUIRY_ACTIONS,
  ExternalInquirySessionLinksSchema,
  ExternalInquiryPermissionSchema,
  PLAN_APPROVAL_ACTIONS,
  PlanApprovalPermissionSchema,
  RetryPermissionSchema,
  ToolEditPermissionSchema,
  USER_QUESTION_ACTIONS,
  UserQuestionAnswersSchema,
  UserQuestionPermissionSchema,
} from './prompts';
import { StreamStatusSchema, StreamTabInfoSchema } from './stream';
import {
  ActiveChildInfoSchema,
  ConversationProgressSchema,
  StreamMetadataSchema,
} from './streamState';
import { PlanSchema } from './plan';
import { TodoItemSchema } from './todo';
import { ContextStateDataSchema } from './contextManagement';
import { TokenUsageStatsSchema } from './usage';

// ============================================================
// Shared Field Schemas
// ============================================================

export const AgentCategoryFilterSchema = z.union([
  z.literal('all'),
  AgentCategorySchema,
]);
export type AgentCategoryFilter = z.infer<typeof AgentCategoryFilterSchema>;

export const ProgressViewPlacementSchema = z.enum(['sidebar', 'editor']);
export type ProgressViewPlacement = z.infer<typeof ProgressViewPlacementSchema>;

// ============================================================
// Progress View Data Schemas
// ============================================================

export const MissingOutputsPayloadSchema = z.object({
  missing: z.array(z.string()).prefault([]),
  xmlFile: z.string().nullable().prefault(null),
  documentTag: z.string().nullable().prefault(null),
});

const ToolUseStatusSchema = z.enum(['in_progress', 'completed']);

export const ToolUseLogSchema = z.object({
  toolName: z.string().optional(),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  isError: z.boolean().optional(),
  userInstruction: z.string().optional(),
  status: ToolUseStatusSchema.optional(),
});
export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

const NormalizedToolUseSchema = z.object({
  parsed: z.record(z.string(), z.unknown()),
  toolName: z.string(),
  errorText: z.string(),
  outputText: z.string(),
  userInstructionText: z.string(),
  input: z.unknown(),
  isError: z.boolean(),
  isUserFeedback: z.boolean(),
  headerSummary: z.string(),
  status: ToolUseStatusSchema.optional(),
});
export type NormalizedToolUse = z.infer<typeof NormalizedToolUseSchema>;

export const WebSearchResultItemSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  domain: z.string().optional(),
});
export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

export const WebSearchPayloadSchema = z.object({
  query: z.string().optional(),
  results: z.array(WebSearchResultItemSchema).optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
});
export type WebSearchPayload = z.infer<typeof WebSearchPayloadSchema>;

export const WebFetchPayloadSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
});
export type WebFetchPayload = z.infer<typeof WebFetchPayloadSchema>;

// ============================================================
// Outbound Message Schemas (backend -> frontend)
// ============================================================

export const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
  agentFilter: AgentCategoryFilterSchema,
  streamStates: z.record(z.string(), StreamMetadataSchema).optional(),
});

export const SetActiveStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
});

export const UpdateConversationProgressMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS),
  stream: StreamTabIdSchema,
  progress: ConversationProgressSchema,
});

export const UpdateStreamBadgesMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES),
  stream: StreamTabIdSchema,
  activeSubagents: z.array(ActiveChildInfoSchema),
  finishedSubagentCount: z.number(),
  activeProcesses: z.array(ActiveChildInfoSchema),
  finishedProcessCount: z.number(),
});

export const UpdateProcessOutputMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT),
  stream: StreamTabIdSchema,
  executionId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
});

export const UpdateParentStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM),
  stream: StreamTabIdSchema,
  parentStreamId: StreamTabIdSchema.nullish(),
});

export const UpdateStreamDescriptionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION),
  stream: StreamTabIdSchema,
  description: z.string(),
});

export const UpdateStreamStatusMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS),
  stream: StreamTabIdSchema,
  status: StreamStatusSchema,
  lastTimestamp: z.number().optional(),
});

export const LogDeltaMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.LOG_DELTA),
  streamId: StreamTabIdSchema,
  entries: z.array(StreamLogEntrySchema),
  updates: z.array(StreamLogEntrySchema).prefault([]),
});

export const UpdateFilesMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FILES),
  stream: StreamTabIdSchema,
  rounds: z.record(z.string(), z.array(OutputFileInfoSchema)).optional(),
  reset: z.boolean().optional(),
});

export const UpdateMissingOutputsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS),
  stream: StreamTabIdSchema,
  rounds: z.record(z.string(), z.array(z.string())).optional(),
  reset: z.boolean().optional(),
});

export const UpdateCompileFailuresMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES),
  stream: StreamTabIdSchema,
  rounds: z.record(z.string(), z.array(CompileFailureSchema)).optional(),
  reset: z.boolean().optional(),
});

export const UpdateTodosMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  stream: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});

export const UpdatePlanMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PLAN),
  stream: StreamTabIdSchema,
  plan: PlanSchema.nullable(),
});

export const UpdateRunUsageMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE),
  stream: StreamTabIdSchema,
  runId: z.string(),
  usage: TokenUsageStatsSchema,
});

export const UpdateQueuedFollowUpsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
  stream: StreamTabIdSchema,
  messages: z.array(z.string()),
});

export const SetFollowupOptionsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS),
  stream: StreamTabIdSchema,
  toolUseAgentsData: z.array(AgentOptionDataSchema).optional(),
  modelOptionsData: z.array(ModelOptionDataSchema).optional(),
});
export type SetFollowupOptionsMessage = z.infer<
  typeof SetFollowupOptionsMessageSchema
>;

const PermissionKindSchema = z.enum([
  'toolEdit',
  'bash',
  'retry',
  'proposal',
  'planApproval',
  'externalInquiry',
  'userQuestion',
]);
export type ProgressPermissionKind = z.infer<typeof PermissionKindSchema>;

const PermissionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('toolEdit'),
    data: ToolEditPermissionSchema,
  }),
  z.object({
    kind: z.literal('bash'),
    data: BashPermissionSchema,
  }),
  z.object({
    kind: z.literal('retry'),
    data: RetryPermissionSchema,
  }),
  z.object({
    kind: z.literal('proposal'),
    data: AgentProposalPermissionSchema,
    modelOptionsData: z.array(ModelOptionDataSchema).optional(),
    agentOptionsData: z.array(AgentOptionDataSchema).optional(),
  }),
  z.object({
    kind: z.literal('planApproval'),
    data: PlanApprovalPermissionSchema,
  }),
  z.object({
    kind: z.literal('externalInquiry'),
    data: ExternalInquiryPermissionSchema,
  }),
  z.object({
    kind: z.literal('userQuestion'),
    data: UserQuestionPermissionSchema,
  }),
]);
export type PermissionPayload = z.infer<typeof PermissionPayloadSchema>;

export const UpdatePermissionMessageSchema = z.discriminatedUnion('action', [
  z.object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    action: z.literal('show'),
    permission: PermissionPayloadSchema,
  }),
  z.object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION),
    action: z.literal('resolve'),
    kind: PermissionKindSchema,
    id: z.string(),
  }),
]);
export type UpdatePermissionMessage = z.infer<
  typeof UpdatePermissionMessageSchema
>;

const BypassTypeSchema = z.enum(['toolEdit', 'superYolo']);

export const UpdateBypassMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS),
  stream: StreamTabIdSchema,
  type: BypassTypeSchema,
  bypassActive: z.boolean(),
});

const FollowUpTextKindSchema = z.enum([
  'polished',
  'polishError',
  'transcribed',
]);

export const UpdateFollowUpTextMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT),
  stream: StreamTabIdSchema.nullish(),
  kind: FollowUpTextKindSchema,
  text: z.string().nullish(),
  error: z.string().optional(),
});

const RecordingStatusSchema = z.enum(['started', 'stopped', 'error']);

export const UpdateRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING),
  status: RecordingStatusSchema,
  error: z.string().optional(),
});

export const SyncStreamContentMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
  stream: z.union([StreamTabIdSchema, z.literal('')]),
  action: z.enum(['render', 'clear']).optional(),
  // Workflow flat files (one run per tab)
  workflowFiles: z.record(z.string(), z.array(OutputFileInfoSchema)).optional(),
  workflowMissingOutputs: z.record(z.string(), z.array(z.string())).optional(),
  workflowCompileFailures: z
    .record(z.string(), z.array(CompileFailureSchema))
    .optional(),
  // Per-run usage map — used by both workflow and tool-use so resume
  // correctly accumulates. Frontend derives sessionUsage as the sum.
  runUsage: z.record(z.string(), TokenUsageStatsSchema).optional(),
  contextState: ContextStateDataSchema.optional(),
  todos: z.array(TodoItemSchema).optional(),
  plan: PlanSchema.nullable().optional(),
  queuedFollowUps: z.array(z.string()).optional(),
  agentCategory: z.string().optional(),
  // Tab-switch state (R2: replaces separate syncActiveStreamState messages)
  conversationProgress: ConversationProgressSchema.optional(),
  badges: z
    .object({
      activeSubagents: z.array(ActiveChildInfoSchema),
      finishedSubagentCount: z.number(),
      activeProcesses: z.array(ActiveChildInfoSchema),
      finishedProcessCount: z.number(),
    })
    .optional(),
  parentStreamId: StreamTabIdSchema.optional(),
  // Toggle bypass state (hydrated on tab switch so toggles display correctly)
  toolEditBypass: z.boolean().optional(),
  superYoloBypass: z.boolean().optional(),
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

export const SetPlacementMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_PLACEMENT),
  placement: ProgressViewPlacementSchema,
});

export const ProgressViewOutboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    UpdateStreamsMessageSchema,
    SetActiveStreamMessageSchema,
    UpdateConversationProgressMessageSchema,
    UpdateStreamBadgesMessageSchema,
    UpdateProcessOutputMessageSchema,
    UpdateParentStreamMessageSchema,
    UpdateStreamDescriptionMessageSchema,
    UpdateStreamStatusMessageSchema,
    LogDeltaMessageSchema,
    UpdateFilesMessageSchema,
    UpdateMissingOutputsMessageSchema,
    UpdateCompileFailuresMessageSchema,
    UpdateTodosMessageSchema,
    UpdatePlanMessageSchema,
    UpdateRunUsageMessageSchema,
    UpdateQueuedFollowUpsMessageSchema,
    SetFollowupOptionsMessageSchema,
    SyncStreamContentMessageSchema,
    UpdatePermissionMessageSchema,
    UpdateBypassMessageSchema,
    UpdateFollowUpTextMessageSchema,
    UpdateRecordingMessageSchema,
    SetPlacementMessageSchema,
    ProgressSetThemeMessageSchema,
    ProgressDeleteStreamMessageSchema,
    ProgressDeleteAllMessageSchema,
  ],
);

export type ProgressViewOutboundMessage = z.infer<
  typeof ProgressViewOutboundMessageSchema
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

const SwitchViewMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SWITCH_VIEW),
  view: z.enum(['main', 'progress', 'dashboard']),
  openInEditor: z.boolean().nullish(),
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

const StartRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.START_RECORDING),
});

const StopRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.STOP_RECORDING),
});

const PopOutMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POP_OUT),
});

const PopBackMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.POP_BACK),
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

const CompactResponseMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.COMPACT_RESPONSE),
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

const RunCompileFixerMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER),
  stream: StreamTabIdSchema,
});

const GetFollowupOptionsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS),
  stream: StreamTabIdSchema,
});

const FollowupConfigSchema = z.object({
  stream: StreamTabIdSchema,
  agent: TrimmedStringSchema,
  model: TrimmedStringSchema,
  initialQuestion: z.string().optional(),
});

const SetupFollowupMessageSchema = FollowupConfigSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP),
});

const RunFollowupMessageSchema = FollowupConfigSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP),
});

const CancelRetryRequestMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST),
  stream: StreamTabIdSchema,
});

const UseOwnApiKeyMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY),
  stream: StreamTabIdSchema,
  provider: z.string().optional(),
  /** True when the underlying cause is an upstream provider credit
   *  depletion (Anthropic 400 "credit balance is too low"), meaning the
   *  stored key IS the depleted credential. The handler requires a new
   *  key for these rather than reusing the stored one. */
  upstreamCreditDepleted: z.boolean().optional(),
  /** True when the failing request went through the TeXRA relay. When
   *  false, relay wasn't in the path (direct-key call) and the handler
   *  must not globally disable relay access — other providers may still
   *  be served successfully by relay. */
  viaRelay: z.boolean().optional(),
});

const ToggleToolEditApprovalBypassMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS),
  stream: StreamTabIdSchema,
});

const ToggleSuperYoloBypassMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS),
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

const FilterStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS),
  filter: AgentCategoryFilterSchema,
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
  model: z.string().optional(),
  agent: z.string().optional(),
});
export type ProgressAgentProposalActionMessage = z.infer<
  typeof AgentProposalActionMessageSchema
>;

const PlanApprovalActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION),
  approvalId: z.string().min(1),
  action: z.enum(PLAN_APPROVAL_ACTIONS),
  feedback: z.string().optional(),
});

const ExternalInquiryActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION),
  requestId: z.string().min(1),
  action: z.enum([...EXTERNAL_INQUIRY_ACTIONS, 'skip'] as const),
  answer: z.string().optional(),
  feedback: z.string().optional(),
  sessionLinks: ExternalInquirySessionLinksSchema.optional(),
});

const UserQuestionActionMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION),
  requestId: z.string().min(1),
  action: z.enum([...USER_QUESTION_ACTIONS, 'skip'] as const),
  answers: UserQuestionAnswersSchema.optional(),
  feedback: z.string().optional(),
});

const RestoreProposalConfigMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RESTORE_PROPOSAL_CONFIG),
  proposal: AgentProposalSchema,
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

export const ProgressViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    WebviewReadyMessageSchema,
    SwitchViewMessageSchema,
    ThemeSetMessageSchema,
    DebugModeSetMessageSchema,
    SwitchStreamMessageSchema,
    InboundDeleteStreamMessageSchema,
    InboundDeleteAllMessageSchema,
    StopStreamMessageSchema,
    CompactResponseMessageSchema,
    ResumeMessageSchema,
    RunNewMessageSchema,
    DiffStreamMessageSchema,
    PackStreamMessageSchema,
    CleanStreamMessageSchema,
    RestoreStateMessageSchema,
    OpenTaskStorageMessageSchema,
    RunCompileFixerMessageSchema,
    FilterStreamsMessageSchema,
    SendFollowUpMessageSchema,
    PolishFollowUpMessageSchema,
    RetryStreamRequestMessageSchema,
    CancelRetryRequestMessageSchema,
    UseOwnApiKeyMessageSchema,
    StartRecordingMessageSchema,
    StopRecordingMessageSchema,
    PopOutMessageSchema,
    PopBackMessageSchema,
    ToolEditApprovalActionMessageSchema,
    ToggleToolEditApprovalBypassMessageSchema,
    ToggleSuperYoloBypassMessageSchema,
    BashApprovalActionMessageSchema,
    AgentProposalActionMessageSchema,
    PlanApprovalActionMessageSchema,
    ExternalInquiryActionMessageSchema,
    UserQuestionActionMessageSchema,
    RestoreProposalConfigMessageSchema,
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
