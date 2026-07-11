/**
 * ProgressView outbound message schemas (backend -> frontend): UPDATE_*, SYNC_*,
 * permission/bypass updates, and the discriminated union + dispatcher they
 * compose into.
 */
import { z } from 'zod';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { GoalStatusSchema } from '../goal';

import { StreamTabIdSchema } from '../identifiers';
import { StreamLogEntrySchema, StreamLogTextDeltaSchema } from '../log';
import { AgentOptionDataSchema, ModelOptionDataSchema } from '../mainView';
import { CompileFailureSchema, OutputFileInfoSchema } from '../output';
import { roundIndexedRecord } from '../roundIndexed';
import { InquiryThreadUpdatedEventSchema } from '../inquiry';
import {
  AgentProposalPermissionSchema,
  BashPermissionSchema,
  ExternalInquiryPermissionSchema,
  PlanApprovalPermissionSchema,
  RetryPermissionSchema,
  ToolEditPermissionSchema,
  UserQuestionPermissionSchema,
} from '../prompts';
import {
  StreamPhaseSchema,
  StreamSubstateSchema,
  StreamTabInfoSchema,
} from '../stream';
import {
  ActiveChildInfoSchema,
  ConversationProgressSchema,
  RoundStageSchema,
  StreamMetadataSchema,
} from '../streamState';
import { PlanSchema } from '../plan';
import { TodoItemSchema } from '../todo';
import { ContextStateDataSchema } from '../contextManagement';
import { RunUsageMapSchema, TokenUsageStatsSchema } from '../usage';
import {
  AgentCategoryFilterSchema,
  ProcessOutputTailSchema,
  ProgressViewPlacementSchema,
  StreamScopedBaseSchema,
} from './data';

export const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
  agentFilter: AgentCategoryFilterSchema,
  streamStates: z.record(z.string(), StreamMetadataSchema).optional(),
  /**
   * Commands this host's inbound registry declares `unsupported(...)` —
   * derived once from the registry (see `unsupportedCommands` in
   * `@shared/utils/dispatcher`), not a hand-maintained list. Drives
   * StreamHeader's capability gating so it renders no control the active
   * host can't act on.
   */
  unsupportedCommands: z.array(z.string()).optional(),
});

export const UpdateStreamMetadataMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA),
  streamInfo: StreamTabInfoSchema,
  streamState: StreamMetadataSchema,
  activeStream: z.union([StreamTabIdSchema, z.literal('')]).optional(),
  agentFilter: AgentCategoryFilterSchema.optional(),
});

export const SetActiveStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
});

export const UpdateConversationProgressMessageSchema =
  StreamScopedBaseSchema.extend({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS),
    progress: ConversationProgressSchema,
  });

export const UpdateRoundStageMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_ROUND_STAGE),
  roundStage: RoundStageSchema,
});

export const UpdateStreamBadgesMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES),
  activeSubagents: z.array(ActiveChildInfoSchema),
  finishedSubagentCount: z.number(),
  activeProcesses: z.array(ActiveChildInfoSchema),
  finishedProcessCount: z.number(),
});

export const UpdateProcessOutputMessageSchema = StreamScopedBaseSchema.extend(
  ProcessOutputTailSchema.shape,
).extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT),
  executionId: z.string(),
});

export const UpdateParentStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM),
  parentStreamId: StreamTabIdSchema.nullish(),
});

export const UpdateStreamDescriptionMessageSchema =
  StreamScopedBaseSchema.extend({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION),
    description: z.string(),
  });

export const UpdateStreamStatusMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS),
  status: StreamPhaseSchema,
  substate: StreamSubstateSchema.optional(),
  lastTimestamp: z.number().optional(),
});

export const LogDeltaMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.LOG_DELTA),
  streamId: StreamTabIdSchema,
  entries: z.array(StreamLogEntrySchema),
  updates: z.array(StreamLogEntrySchema).prefault([]),
  textDeltas: z.array(StreamLogTextDeltaSchema).prefault([]),
});

// Round-keyed update messages share one shape: a stream id, an optional
// `rounds` record of per-round arrays, and an optional `reset` flag. The
// generic `command`/element params keep each `command` literal distinct so the
// outbound discriminated union still narrows.
function RoundUpdateMessageSchema<C extends string, T extends z.ZodType>(
  command: C,
  elementSchema: T,
) {
  return StreamScopedBaseSchema.extend({
    command: z.literal(command),
    rounds: roundIndexedRecord(elementSchema).optional(),
    reset: z.boolean().optional(),
  });
}

export const UpdateFilesMessageSchema = RoundUpdateMessageSchema(
  PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
  OutputFileInfoSchema,
);

export const UpdateMissingOutputsMessageSchema = RoundUpdateMessageSchema(
  PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
  z.string(),
);

export const UpdateCompileFailuresMessageSchema = RoundUpdateMessageSchema(
  PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
  CompileFailureSchema,
);

export const UpdateTodosMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  todos: z.array(TodoItemSchema),
});

export const UpdatePlanMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PLAN),
  plan: PlanSchema.nullable(),
});

export const UpdateRunUsageMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE),
  runId: z.string(),
  usage: TokenUsageStatsSchema,
});

export const UpdateQueuedFollowUpsMessageSchema = StreamScopedBaseSchema.extend(
  {
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
    messages: z.array(z.string()),
  },
);

export const SetFollowupOptionsMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS),
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
const BypassTypeSchema = z.enum(['toolEdit', 'superYolo']);

export const UpdateBypassMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS),
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

export const SyncInquiryThreadsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS),
  threads: z.array(InquiryThreadUpdatedEventSchema),
});

export const UpdateInquiryThreadMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD),
  thread: InquiryThreadUpdatedEventSchema,
});

export const SyncStreamContentMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
  stream: z.union([StreamTabIdSchema, z.literal('')]),
  action: z.enum(['render', 'clear']).optional(),
  // Workflow flat files (one run per tab)
  workflowFiles: roundIndexedRecord(OutputFileInfoSchema).optional(),
  workflowMissingOutputs: roundIndexedRecord(z.string()).optional(),
  workflowCompileFailures: roundIndexedRecord(CompileFailureSchema).optional(),
  // Per-run usage map — used by both workflow and tool-use so resume
  // correctly accumulates. Frontend derives sessionUsage as the sum.
  runUsage: RunUsageMapSchema.optional(),
  contextState: ContextStateDataSchema.optional(),
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  queuedFollowUps: z.array(z.string()),
  agentCategory: z.string().optional(),
  // Tab-switch state (R2: replaces separate syncActiveStreamState messages)
  conversationProgress: ConversationProgressSchema.optional(),
  roundStage: RoundStageSchema.nullable().optional(),
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
  goalActive: z.boolean().optional(),
  goalStatus: GoalStatusSchema.optional(),
  goalObjective: z.string().optional(),
});

export type SyncStreamContentPayload = Omit<
  z.infer<typeof SyncStreamContentMessageSchema>,
  'command'
>;

const GoalActiveUpdatedMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED),
  active: z.boolean(),
  status: GoalStatusSchema.optional(),
  objective: z.string().optional(),
});

export const ProgressSetThemeMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: z.enum(['dark', 'light']),
});

export const ProgressDeleteStreamMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.DELETE_STREAM),
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
    UpdateStreamMetadataMessageSchema,
    SetActiveStreamMessageSchema,
    UpdateConversationProgressMessageSchema,
    UpdateRoundStageMessageSchema,
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
    GoalActiveUpdatedMessageSchema,
    UpdateFollowUpTextMessageSchema,
    UpdateRecordingMessageSchema,
    SyncInquiryThreadsMessageSchema,
    UpdateInquiryThreadMessageSchema,
    SetPlacementMessageSchema,
    ProgressSetThemeMessageSchema,
    ProgressDeleteStreamMessageSchema,
    ProgressDeleteAllMessageSchema,
  ],
);

export type ProgressViewOutboundMessage = z.infer<
  typeof ProgressViewOutboundMessageSchema
>;

export type ProgressViewOutboundHandlerRegistry =
  HandlerRegistry<ProgressViewOutboundMessage>;

export const dispatchProgressViewOutbound = createDispatcher(
  ProgressViewOutboundMessageSchema,
);
