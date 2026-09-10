import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { RunIdentitySchema } from './runIdentity';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import { roundIndexedRecord } from './roundIndexed';
import { RunPhaseSchema } from './run';

// Active Child Info — one flat row shape. Every child owns a stream tab
// (`childRunId` always present) and carries its parsed `identity`
// verbatim; renderers key icons and clickability on `identity.kind` instead
// of tool-name sniffing or a roster-side kind union.

export const ActiveChildInfoSchema = z.object({
  runId: z.string(),
  /** Stream tab ID — every child stream owns a tab. */
  childRunId: z.string(),
  /** What owns the child stream — every roster emitter declares it. */
  identity: RunIdentitySchema,
  agentName: z.string(),
  /**
   * Current run phase. Takes `RunPhase` only: no artifact carries a
   * roster (see the note above), so there is nothing to normalize here.
   */
  status: RunPhaseSchema.optional(),
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
   * know `phase`) — `WorkflowCallIdentity` carries no run or stream id.
   * Immutable per attempt: it is stamped on the handle before the first
   * `RunRegistry.onChildActivity` notification, so retained (finished)
   * rows keep it. Optional because only a workflow-script run's children have
   * an owning phase.
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
export const RunStageSchema = z.discriminatedUnion('kind', [
  RoundStageSchema.extend({ kind: z.literal('round') }),
  PhaseStageSchema.extend({ kind: z.literal('phase') }),
]);

export type RunStage = z.infer<typeof RunStageSchema>;

// Conversation Progress (tool-call counters updated during run)

export const ConversationProgressSchema = z.object({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number().prefault(0),
});

export type ConversationProgress = z.infer<typeof ConversationProgressSchema>;

export const ApprovalBypassesSchema = z.record(
  z.enum(APPROVAL_BYPASS_KINDS),
  z.boolean(),
);

export const RoundKeyedOutputSidecarValueSchemas = {
  outputFiles: roundIndexedRecord(OutputFileInfoSchema),
  missingOutputs: roundIndexedRecord(z.string()),
  compileFailures: roundIndexedRecord(CompileFailureSchema),
} as const;
