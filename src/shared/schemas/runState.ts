import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { RunIdSchema } from './identifiers';
import { RunIdentitySchema } from './runIdentity';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import { roundIndexedRecord } from './roundIndexed';
import { RunPhaseSchema } from './run';

// Active Child Info — one flat row shape. `childRunId` is the child's run id
// and the only id on the row; the child carries its parsed `identity`
// verbatim, and renderers key icons and clickability on `identity.kind`
// instead of tool-name sniffing or a roster-side kind union.

const ActiveChildInfoSchema = z.object({
  /** The child's run id. */
  childRunId: RunIdSchema,
  /** What owns the child run — every roster emitter declares it. */
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
   * elapsed time comes from the child run's `runStartedAt` instead.
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
   * know `phase`) — `WorkflowCallIdentity` carries no run id.
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
