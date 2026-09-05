import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { GoalStateSchema } from './goal';
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

const ActiveChildInfoSchema = z.object({
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
  /**
   * Epoch milliseconds when the current child handle generation was created.
   * Kept on the wire for live and retained roster rows; live active-phase
   * elapsed time comes from the child stream's `runStartedAt` instead.
   */
  startedAt: z.int().positive().optional(),
  /**
   * Epoch milliseconds when the child left its parent's active roster.
   * Presence — and ONLY presence — means this row is a finished child retained
   * for display. The `status` string is display-only and can lag the roster
   * drop, so it must never be used to decide list membership.
   */
  finishedAt: z.int().positive().optional(),
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

const DEFAULT_STREAM_METADATA_STATUS = STREAM_STATUS.READY;

// Stream Metadata — the lightweight subset sent over postMessage in UPDATE_STREAMS.
// Contains only backend-owned fields that mergeBackendOwnedState() actually reads.

export const BackendOwnedFieldsSchema = z.object({
  status: StreamLifecycleStatusSchema.prefault(DEFAULT_STREAM_METADATA_STATUS),
  /**
   * Whether `status` is a terminal outcome that no producer can still move.
   * The fold's `runDurablyFinal` produces it from the stream's status and
   * the local snapshot, which needs the terminal outcome plus one of two
   * ways to have no producer left: the phase came
   * from the durable facts (origin `derived`, so nothing is running this
   * stream anywhere), or it is this process's own `live` entry with no hold
   * and no execution still tracked for the stream — the case where
   * `finalizeRunTerminal` untracked the run before storing its terminal
   * phase. The phase alone does not carry that — a user stop publishes
   * CANCELLED while the run is still unwinding in the host process — so this
   * is the bit a renderer needs before painting an unclosed task group or an
   * unsettled workflow card as interrupted.
   */
  statusDurablyFinal: z.boolean().prefault(false),
  substate: StreamSubstateSchema.optional(),
  /** Present only with the `unavailable` sentinel: the banner and tooltip copy. */
  statusDetail: z.string().optional(),
  /**
   * Epoch ms when the stream entered its current active phase, stamped once by
   * the session status machine (`StreamPhaseState.runStartedAt`). Absent while
   * the phase is not active. Every host renders elapsed time from this one
   * value; the tick rate and duration format stay host modality.
   */
  runStartedAt: z.int().positive().optional(),
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport: UserFollowUpSupportSchema.optional(),
  lastTimestamp: z.number().optional(),
  conversationProgress: ConversationProgressSchema.prefault({
    toolCallCount: 0,
  }),
  stage: StreamStageSchema.optional(),
  /** Child roster — live entries plus the finished ones retained for display
   *  (`finishedAt` set). */
  subagents: z.array(ActiveChildInfoSchema).prefault([]),
});

export const ApprovalBypassesSchema = z.record(
  z.enum(APPROVAL_BYPASS_KINDS),
  z.boolean(),
);

export const RoundKeyedOutputSidecarValueSchemas = {
  outputFiles: roundIndexedRecord(OutputFileInfoSchema),
  missingOutputs: roundIndexedRecord(z.string()),
  compileFailures: roundIndexedRecord(CompileFailureSchema),
} as const;
