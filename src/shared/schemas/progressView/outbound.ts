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
import { ThemeSchema } from '../commonViewMessages';
import { GoalStatusSchema } from '../goal';
import { AgentCategory } from '../agent';

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

const StreamContentRenderFields = {
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
  action: z.literal('render'),
  stream: StreamTabIdSchema,
  // Per-run usage is shared by both stream kinds. The frontend derives the
  // cumulative session total from this canonical map.
  runUsage: RunUsageMapSchema,
  // Active state is all-or-nothing. Partial tab-activation snapshots would
  // preserve unrelated stale fields in the frontend.
  activeState: z
    .strictObject({
      conversationProgress: ConversationProgressSchema,
      roundStage: RoundStageSchema.nullable(),
      badges: z.strictObject({
        activeSubagents: z.array(ActiveChildInfoSchema),
        finishedSubagentCount: z.number(),
        activeProcesses: z.array(ActiveChildInfoSchema),
        finishedProcessCount: z.number(),
      }),
      parentStreamId: StreamTabIdSchema.nullable(),
    })
    .optional(),
};

const ClearStreamContentMessageSchema = z.strictObject({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
  action: z.literal('clear'),
});

const WorkflowStreamContentMessageSchema = z.strictObject({
  ...StreamContentRenderFields,
  kind: z.literal(AgentCategory.Workflow),
  outputs: z.strictObject({
    files: roundIndexedRecord(OutputFileInfoSchema),
    missing: roundIndexedRecord(z.string()),
    compileFailures: roundIndexedRecord(CompileFailureSchema),
  }),
});

const GoalSyncSchema = z.discriminatedUnion('active', [
  z.strictObject({ active: z.literal(false) }),
  z.strictObject({
    active: z.literal(true),
    status: GoalStatusSchema,
    objective: z.string(),
  }),
]);

const ToolUseStreamContentMessageSchema = z.strictObject({
  ...StreamContentRenderFields,
  kind: z.literal(AgentCategory.ToolUse),
  workPlan: z.strictObject({
    todos: z.array(TodoItemSchema),
    plan: PlanSchema.nullable(),
    queuedFollowUps: z.array(z.string()),
  }),
  controls: z.strictObject({
    toolEditBypass: z.boolean(),
    superYoloBypass: z.boolean(),
    goal: GoalSyncSchema,
  }),
});

/** Full tab snapshots, expressed as the only three valid transport states. */
const RenderStreamContentMessageSchema = z.discriminatedUnion('kind', [
  WorkflowStreamContentMessageSchema,
  ToolUseStreamContentMessageSchema,
]);

export const SyncStreamContentMessageSchema = z.discriminatedUnion('action', [
  ClearStreamContentMessageSchema,
  RenderStreamContentMessageSchema,
]);

type WithoutCommand<T> = T extends unknown ? Omit<T, 'command'> : never;

export type SyncStreamContentPayload = WithoutCommand<
  z.infer<typeof SyncStreamContentMessageSchema>
>;

export type WorkflowStreamContentPayload = Extract<
  SyncStreamContentPayload,
  { action: 'render'; kind: typeof AgentCategory.Workflow }
>;

export type ToolUseStreamContentPayload = Extract<
  SyncStreamContentPayload,
  { action: 'render'; kind: typeof AgentCategory.ToolUse }
>;

export type StreamContentRenderPayload =
  WorkflowStreamContentPayload | ToolUseStreamContentPayload;

const GoalActiveUpdatedMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED),
  active: z.boolean(),
  status: GoalStatusSchema.optional(),
  objective: z.string().optional(),
});

// `theme` reuses the canonical `ThemeSchema` (`commonViewMessages.ts`) rather
// than a locally re-declared enum — the actual desktop theme kind includes
// `'high-contrast'` (see `DESKTOP_THEME_KIND`), which
// `COMMON_COMMANDS.THEME_SET` messages already carry for both mainView and
// progressView; a narrower local enum here previously just hadn't been
// exercised against real payloads before outbound send validation (#8123).
export const ProgressSetThemeMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.THEME_SET),
  theme: ThemeSchema,
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
