/**
 * Host-neutral stream display shape. RunSnapshotStore reconstructs durable
 * fields from committed events; views combine those fields with transcript
 * and live run information. This display schema does not define the
 * flow checkpoint or the resume protocol.
 */

import { z } from 'zod';

import { RunIdSchema } from './identifiers';
import { RunPhaseSchema } from './run';
import {
  ActiveChildInfoSchema,
  ConversationProgressSchema,
  RoundKeyedOutputSidecarValueSchemas,
} from './runState';
import { RunUsageMapSchema } from './usage';
import { WorkPlanSnapshotShape } from './workPlan';

/** Version of the exported logical snapshot shape. */
const RUN_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// RunSnapshot — the assembled logical view (durable + log-derived + liveness)
// ============================================================================

export const RunSnapshotSchema = z.object({
  /**
   * Missing on legacy assemblies/exports → current version; a PRESENT wrong
   * version fails the parse loudly (`.prefault`, not `.catch` — a swallowed
   * future version would consume unknown-shaped fields as v1).
   */
  schemaVersion: z
    .literal(RUN_SNAPSHOT_SCHEMA_VERSION)
    .prefault(RUN_SNAPSHOT_SCHEMA_VERSION),
  runId: RunIdSchema,

  // -- Durable display state (persisted in field-scoped files) --------------
  todos: WorkPlanSnapshotShape.todos.prefault([]),
  plan: WorkPlanSnapshotShape.plan.prefault(null),
  planSummary: WorkPlanSnapshotShape.planSummary.prefault(null),
  // Round-keyed records match the on-disk JSON: string keys → arrays. Value
  // schemas shared with the live WorkflowRunStateSchema (see
  // RoundKeyedOutputSidecarValueSchemas) so the two can't drift.
  outputFilesByRound: RoundKeyedOutputSidecarValueSchemas.outputFiles.prefault(
    {},
  ),
  missingOutputsByRound:
    RoundKeyedOutputSidecarValueSchemas.missingOutputs.prefault({}),
  compileFailuresByRound:
    RoundKeyedOutputSidecarValueSchemas.compileFailures.prefault({}),
  runUsage: RunUsageMapSchema.prefault({}),

  // -- The parent edge, from `run.start.parent` until a `run.detach` -------
  parentRunId: RunIdSchema.optional(),

  // -- Log-derived (recomputed from the StreamLog on load) ------------------
  status: RunPhaseSchema.optional(),
  conversationProgress: ConversationProgressSchema.prefault({
    toolCallCount: 0,
  }),

  // -- Liveness (NEVER restored as live — clamp on hydrate) -----------------
  /** Child roster — live entries plus the finished ones retained for display
   *  (`finishedAt` set). */
  subagents: z.array(ActiveChildInfoSchema).prefault([]),
});

export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
