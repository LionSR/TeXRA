import { z } from 'zod';

import { GoalStatusSchema } from './goal';
import { AgentCategory, AgentCategorySchema } from './agent';
import { RunIdentitySchema } from './runIdentity';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import { roundIndexedRecord } from './roundIndexed';
import {
  STREAM_STATUS,
  StreamLifecycleStatusSchema,
  StreamPhaseSchema,
  StreamSubstateSchema,
  UserFollowUpSupportSchema,
} from './stream';
import { TaskGroupSchema } from './taskGroup';
import { PlanSchema } from './plan';
import { TodoItemSchema } from './todo';
import { ContextStateDataSchema } from './contextManagement';
import { RunUsageMapSchema } from './usage';

// Active Child Info — one flat row shape. Every child owns a stream tab
// (`childStreamId` always present) and carries its parsed `identity`
// verbatim; renderers key icons and clickability on `identity.kind` instead
// of tool-name sniffing or a roster-side kind union.

export const ActiveChildInfoSchema = z.object({
  executionId: z.string(),
  /** Stream tab ID — every child stream owns a tab. */
  childStreamId: z.string(),
  /** What owns the child stream — every roster emitter declares it. */
  identity: RunIdentitySchema,
  /** Whether this child can be offered as a native tool-use resume target. */
  resumeEligible: z.boolean().optional(),
  agentName: z.string(),
  /**
   * Current execution phase. Takes `StreamPhase` only: no artifact carries a
   * roster (see the note above), so no input can hold the retired 7-value
   * `StreamStatus` vocabulary and there is nothing to normalize here.
   */
  status: StreamPhaseSchema.optional(),
  /** Epoch milliseconds when the child execution began. */
  startedAt: z.int().positive().optional(),
  /**
   * Epoch milliseconds when the child left its parent's active roster.
   * Presence — and ONLY presence — means this row is a finished child retained
   * for display. The `status` string is display-only and can lag the roster
   * drop, so it must never be used to decide list membership.
   */
  finishedAt: z.int().positive().optional(),
  /** Formatted elapsed time (e.g. "1m 23s"). */
  elapsed: z.string().nullish(),
  /**
   * Workflow-script phase that owns this child, when its parent is a
   * workflow-script run. This is the only join key between a grandchild's
   * roster row (which knows tokens/elapsed) and the run's task cards (which
   * know `phase`) — `WorkflowCallIdentity` carries no execution or stream id.
   * Immutable per attempt: it is stamped on the handle before the first
   * `child.activity` emission, so retained (finished) rows keep it. Optional
   * because only a workflow-script run's children have an owning phase.
   */
  workflowPhase: z.string().optional(),
});

export type ActiveChildInfo = z.infer<typeof ActiveChildInfoSchema>;

// Round Stage (ephemeral round label from typed stage.start metadata)

const RoundStageSchema = z.object({
  /** Zero-based round/turn index. */
  index: z.int().nonnegative(),
  /** Planned total, when known. Reflection workflows set this. */
  total: z.int().positive().optional(),
});

export type RoundStage = z.infer<typeof RoundStageSchema>;

// Phase Stage (ephemeral phase label from typed stage.start metadata)
//
// A workflow-script run advances through named phases instead of the numbered
// rounds used by reflection workflows. Both are projected from the same
// `stage.start` fact, discriminated by its `kind`, and a stream that opens
// phases never opens rounds.

const PhaseStageSchema = z.object({
  /** Phase title, free-form text from the workflow script. */
  label: z.string(),
  /** Zero-based position in the declared phase list. Absent for a phase the
   *  script opened dynamically, which has no declared position. */
  index: z.int().nonnegative().optional(),
  /** Number of declared phases, when known. */
  total: z.int().positive().optional(),
});

export type PhaseStage = z.infer<typeof PhaseStageSchema>;

/**
 * The one discriminated run-progress slot: a reflection workflow advances
 * through numbered rounds, a workflow-script run through named phases — never
 * both — so state and wire carry one `stage` field rather than two
 * independently-optional ones every reader has to fall back between. The arms
 * extend the payload schemas above, so projecting to either is a `kind` strip.
 */
export const StreamStageSchema = z.discriminatedUnion('kind', [
  RoundStageSchema.extend({ kind: z.literal('round') }),
  PhaseStageSchema.extend({ kind: z.literal('phase') }),
]);

export type StreamStage = z.infer<typeof StreamStageSchema>;

// Conversation Progress (tool-call counters updated during execution)

export const ConversationProgressSchema = z.object({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number().prefault(0),
});

export type ConversationProgress = z.infer<typeof ConversationProgressSchema>;

const DEFAULT_CONVERSATION_PROGRESS: ConversationProgress = {
  toolCallCount: 0,
};

export const DEFAULT_STREAM_METADATA_STATUS = STREAM_STATUS.READY;

// Stream Metadata — the lightweight subset sent over postMessage in UPDATE_STREAMS.
// Contains only backend-owned fields that mergeBackendOwnedState() actually reads.

export const BackendOwnedFieldsSchema = z.object({
  status: StreamLifecycleStatusSchema.prefault(DEFAULT_STREAM_METADATA_STATUS),
  substate: StreamSubstateSchema.optional(),
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  lastTimestamp: z.number().optional(),
  conversationProgress: ConversationProgressSchema.prefault(
    DEFAULT_CONVERSATION_PROGRESS,
  ),
  stage: StreamStageSchema.optional(),
  /** Child roster — live entries plus the finished ones retained for display
   *  (`finishedAt` set). */
  subagents: z.array(ActiveChildInfoSchema).prefault([]),
});

export const StreamMetadataSchema = BackendOwnedFieldsSchema.extend({
  // Nullable over the wire: an explicit `null` clears a stage the frontend
  // still holds, which a plain omission cannot express.
  stage: StreamStageSchema.nullish(),
  /** Absent while the stream's run identity is still pending. */
  category: AgentCategorySchema.optional(),
});

export type StreamMetadata = z.infer<typeof StreamMetadataSchema>;

// Base Stream State

const BaseStreamStateSchema = BackendOwnedFieldsSchema.extend({
  // Frontend-owned fields — set by frontend handlers, preserved during backend merges.
  taskGroups: z.array(TaskGroupSchema).prefault([]),
  contextState: ContextStateDataSchema.optional(),
  // Per-run usage, the only stored usage state: the session total is summed
  // at the render site. Both stream kinds carry it so resume accumulates
  // across the original and resumed runs.
  runUsage: RunUsageMapSchema.prefault({}),
});

// Tool-Use UI State (frontend-only, preserved during backend updates)

const ToolUseUIStateSchema = z.object({
  followUpText: z.string().prefault(''),
  polishedText: z.string().nullable().prefault(null),
  polishRevision: z.int().prefault(0),
  transcribedText: z.string().nullable().prefault(null),
  recording: z.boolean().prefault(false),
  shouldFocusFollowUp: z.boolean().prefault(false),
});

// Tool-Use Stream State

const ToolUseStreamStateSchema = BaseStreamStateSchema.extend({
  category: z.literal(AgentCategory.ToolUse),
  // Frontend-owned fields updated by targeted progress-view messages
  todos: z.array(TodoItemSchema).prefault([]),
  plan: PlanSchema.nullable().prefault(null),
  queuedFollowUps: z.array(z.string()).prefault([]),
  bashBypass: z.boolean().optional(),
  toolEditBypass: z.boolean().optional(),
  superYoloBypass: z.boolean().optional(),
  goalActive: z.boolean().optional(),
  goalStatus: GoalStatusSchema.optional(),
  goalObjective: z.string().optional(),
  // Frontend-owned (nested under ui)
  ui: ToolUseUIStateSchema.prefault({}),
});

export type ToolUseStreamState = z.infer<typeof ToolUseStreamStateSchema>;

// Workflow Stream State
// One run per tab — all run-scoped data is flat, not keyed by runId.

/**
 * Value schemas for the three round-keyed output sidecars
 * (`streamData/{id}/outputFiles.json` / `missingOutputs.json` /
 * `compileFailures.json`). Shared between the live workflow stream state and
 * the persisted `StreamSnapshot` (which assembles those files under its own
 * `*ByRound` field names) so the element schemas and `.prefault({})` default
 * can't drift between the two surfaces — the same unification
 * `SharedBackendOwnedFieldsSchema` provides for the metadata fields.
 */
export const RoundKeyedOutputSidecarValueSchemas = {
  outputFiles: roundIndexedRecord(OutputFileInfoSchema),
  missingOutputs: roundIndexedRecord(z.string()),
  compileFailures: roundIndexedRecord(CompileFailureSchema),
} as const;

const WorkflowStreamStateSchema = BaseStreamStateSchema.extend({
  category: z.literal(AgentCategory.Workflow),
  // Frontend-owned fields updated by targeted progress-view messages.
  files: RoundKeyedOutputSidecarValueSchemas.outputFiles.prefault({}),
  missingOutputs: RoundKeyedOutputSidecarValueSchemas.missingOutputs.prefault(
    {},
  ),
  compileFailures: RoundKeyedOutputSidecarValueSchemas.compileFailures.prefault(
    {},
  ),
});

export type WorkflowStreamState = z.infer<typeof WorkflowStreamStateSchema>;

// Discriminated Union

const StreamStateSchema = z.discriminatedUnion('category', [
  ToolUseStreamStateSchema,
  WorkflowStreamStateSchema,
]);

export type StreamState = z.infer<typeof StreamStateSchema>;

// Type Guards

export function isToolUseState(
  state: StreamState,
): state is ToolUseStreamState {
  return state.category === AgentCategory.ToolUse;
}

export function isWorkflowState(
  state: StreamState,
): state is WorkflowStreamState {
  return state.category === AgentCategory.Workflow;
}

// Factory Functions

export function createStreamState(
  agentCategory: AgentCategory,
  partial?: Partial<StreamState>,
): StreamState {
  if (agentCategory === AgentCategory.ToolUse) {
    return ToolUseStreamStateSchema.parse({
      category: AgentCategory.ToolUse,
      ...partial,
    });
  }
  return WorkflowStreamStateSchema.parse({
    category: AgentCategory.Workflow,
    ...partial,
  });
}
