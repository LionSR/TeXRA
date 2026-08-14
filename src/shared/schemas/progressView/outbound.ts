/**
 * ProgressView outbound message schemas (backend -> frontend): UPDATE_*, SYNC_*,
 * permission/bypass updates, and the discriminated union + dispatcher they
 * compose into.
 */
import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { SetThemeMessageSchema } from '../commonViewMessages';
import { commandOnly } from '../messageFactories';
import { GoalStateSchema, GoalStatusSchema } from '../goal';
import { AgentCategory } from '../agent';

import { StreamTabIdSchema } from '../identifiers';
import { StreamLogEntrySchema, StreamLogTextDeltaSchema } from '../log';
import {
  AgentOptionDataSchema,
  ModelOptionDataSchema,
} from '../mainView/state';
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
  StreamStageSchema,
  StreamMetadataSchema,
} from '../streamState';
import { PlanSchema } from '../plan';
import { TodoItemSchema } from '../todo';
import { RunUsageMapSchema, TokenUsageStatsSchema } from '../usage';
import {
  ProgressViewPlacementSchema,
  StreamScopedBaseSchema,
  streamScopedCommand,
} from './data';

const UpdateStreamsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS),
  streams: z.array(StreamTabInfoSchema),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
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

const UpdateStreamMetadataMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA),
  streamInfo: StreamTabInfoSchema,
  streamState: StreamMetadataSchema,
  activeStream: z.union([StreamTabIdSchema, z.literal('')]).optional(),
});

const SetActiveStreamMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
});

const SettleStreamSelectionMessageSchema = z.strictObject({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION),
  requestId: z.string().min(1),
  status: z.enum(['accepted', 'rejected', 'superseded']),
  activeStream: z.union([StreamTabIdSchema, z.literal('')]),
});

const ReleaseStreamContentMessageSchema = z.strictObject({
  command: z.literal(PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT),
  stream: StreamTabIdSchema,
});

const UpdateConversationProgressMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS),
  progress: ConversationProgressSchema,
});

const UpdateStageMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STAGE),
  stage: StreamStageSchema,
});

const UpdateStreamBadgesMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES),
  subagents: z.array(ActiveChildInfoSchema),
});

const UpdateStreamDescriptionMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION),
  description: z.string(),
});

const UpdateStreamStatusMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS),
  status: StreamPhaseSchema,
  substate: StreamSubstateSchema.optional(),
  lastTimestamp: z.number().optional(),
  logHead: z.int().nonnegative(),
});

const LogDeltaMessageSchema = z.object({
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

const UpdateFilesMessageSchema = RoundUpdateMessageSchema(
  PROGRESS_VIEW_COMMANDS.UPDATE_FILES,
  OutputFileInfoSchema,
);

const UpdateMissingOutputsMessageSchema = RoundUpdateMessageSchema(
  PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS,
  z.string(),
);

const UpdateCompileFailuresMessageSchema = RoundUpdateMessageSchema(
  PROGRESS_VIEW_COMMANDS.UPDATE_COMPILE_FAILURES,
  CompileFailureSchema,
);

const UpdateTodosMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_TODOS),
  todos: z.array(TodoItemSchema),
});

const UpdatePlanMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_PLAN),
  plan: PlanSchema.nullable(),
});

const UpdateRunUsageMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE),
  runId: z.string(),
  usage: TokenUsageStatsSchema,
});

const UpdateQueuedFollowUpsMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS),
  messages: z.array(z.string()),
});

const PermissionKindSchema = z.enum(PERMISSION_KIND);
/**
 * The one approval/prompt kind vocabulary. Wire payloads, the backend handler
 * set, the runtime host-interaction kinds, and the CLI approval queue all key
 * off this union, so a spelling that drifts fails to compile.
 */
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

const UpdatePermissionMessageSchema = z.discriminatedUnion('action', [
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
const BypassTypeSchema = z.enum(APPROVAL_BYPASS_KINDS);

const UpdateBypassMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS),
  type: BypassTypeSchema,
  bypassActive: z.boolean(),
});

// `error` is only ever populated (and only ever read) on the `polishError`
// branch — a discriminated union enforces that at the type level instead of
// leaving it a flat optional field a `polished`/`transcribed` sender could
// set by mistake.
const UpdateFollowUpTextMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT),
    stream: StreamTabIdSchema.nullish(),
    kind: z.literal('polished'),
    text: z.string().nullish(),
  }),
  z.object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT),
    stream: StreamTabIdSchema.nullish(),
    kind: z.literal('polishError'),
    text: z.string().nullish(),
    error: z.string().optional(),
  }),
  z.object({
    command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT),
    stream: StreamTabIdSchema.nullish(),
    kind: z.literal('transcribed'),
    text: z.string().nullish(),
  }),
]);

const RecordingStatusSchema = z.enum(['started', 'stopped', 'error']);

const UpdateRecordingMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING),
  status: RecordingStatusSchema,
  error: z.string().optional(),
});

const SyncInquiryThreadsMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS),
  threads: z.array(InquiryThreadUpdatedEventSchema),
});

const UpdateInquiryThreadMessageSchema = z.object({
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
      stage: StreamStageSchema.nullable(),
      badges: z.strictObject({
        subagents: z.array(ActiveChildInfoSchema),
      }),
    })
    .optional(),
};

const ClearStreamContentMessageSchema = z.strictObject({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT),
  action: z.literal('clear'),
});

const WorkflowStreamContentMessageSchema = z.strictObject({
  ...StreamContentRenderFields,
  category: z.literal(AgentCategory.Workflow),
  outputs: z.strictObject({
    files: roundIndexedRecord(OutputFileInfoSchema),
    missing: roundIndexedRecord(z.string()),
    compileFailures: roundIndexedRecord(CompileFailureSchema),
  }),
});

const ToolUseStreamContentMessageSchema = z.strictObject({
  ...StreamContentRenderFields,
  category: z.literal(AgentCategory.ToolUse),
  workPlan: z.strictObject({
    todos: z.array(TodoItemSchema),
    plan: PlanSchema.nullable(),
    queuedFollowUps: z.array(z.string()),
  }),
  controls: z.strictObject({
    bashBypass: z.boolean(),
    toolEditBypass: z.boolean(),
    superYoloBypass: z.boolean(),
    goal: GoalStateSchema,
  }),
});

/** Full tab snapshots, one branch per stream category. */
const RenderStreamContentMessageSchema = z.discriminatedUnion('category', [
  WorkflowStreamContentMessageSchema,
  ToolUseStreamContentMessageSchema,
]);

/** The only valid tab-content transport states: clear, or a full render. */
export const SyncStreamContentMessageSchema = z.discriminatedUnion('action', [
  ClearStreamContentMessageSchema,
  RenderStreamContentMessageSchema,
]);

type WithoutCommand<T> = T extends unknown ? Omit<T, 'command'> : never;

export type SyncStreamContentPayload = WithoutCommand<
  z.infer<typeof SyncStreamContentMessageSchema>
>;

export type StreamContentRenderPayload = Extract<
  SyncStreamContentPayload,
  { action: 'render' }
>;

const GoalActiveUpdatedMessageSchema = StreamScopedBaseSchema.extend({
  command: z.literal(PROGRESS_VIEW_COMMANDS.GOAL_ACTIVE_UPDATED),
  active: z.boolean(),
  status: GoalStatusSchema.optional(),
  objective: z.string().optional(),
});

// DELETE_STREAM / DELETE_ALL are bidirectional echo commands: the backend emits
// them to confirm a deletion and the frontend sends them to request one. Both
// directions compose the identical schema from the shared factories
// (`streamScopedCommand` / `commandOnly`), so a field added to either shape
// propagates to both instead of drifting.
const ProgressDeleteStreamMessageSchema = streamScopedCommand(
  PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
);

const ProgressDeleteAllMessageSchema = commandOnly(
  PROGRESS_VIEW_COMMANDS.DELETE_ALL,
);

const SetPlacementMessageSchema = z.object({
  command: z.literal(PROGRESS_VIEW_COMMANDS.SET_PLACEMENT),
  placement: ProgressViewPlacementSchema,
});

export const ProgressViewOutboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    UpdateStreamsMessageSchema,
    UpdateStreamMetadataMessageSchema,
    SetActiveStreamMessageSchema,
    SettleStreamSelectionMessageSchema,
    ReleaseStreamContentMessageSchema,
    UpdateConversationProgressMessageSchema,
    UpdateStageMessageSchema,
    UpdateStreamBadgesMessageSchema,
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
    SyncStreamContentMessageSchema,
    UpdatePermissionMessageSchema,
    UpdateBypassMessageSchema,
    GoalActiveUpdatedMessageSchema,
    UpdateFollowUpTextMessageSchema,
    UpdateRecordingMessageSchema,
    SyncInquiryThreadsMessageSchema,
    UpdateInquiryThreadMessageSchema,
    SetPlacementMessageSchema,
    SetThemeMessageSchema,
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
