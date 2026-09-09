/**
 * Host-neutral stream display shape. StreamSnapshotStore reconstructs durable
 * fields from committed events; views combine those fields with transcript
 * and live execution information. This display schema does not define the
 * flow checkpoint or the resume protocol.
 */

import { z } from 'zod';

import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';
import { StreamPhaseSchema } from './stream';
import {
  BackendOwnedFieldsSchema,
  RoundKeyedOutputSidecarValueSchemas,
} from './streamState';
import { RunUsageMapSchema } from './usage';
import { WorkPlanSnapshotShape } from './workPlan';

/**
 * The liveness/log-derived fields this snapshot shares with the backend-owned
 * stream-state metadata (`@shared/schemas/streamState`), picked from that one
 * definition so the two can't drift apart field-by-field.
 */
const SharedBackendOwnedFieldsSchema = BackendOwnedFieldsSchema.pick({
  conversationProgress: true,
  subagents: true,
});

/** Version of the exported logical snapshot shape. */
const STREAM_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// StreamSnapshot — the assembled logical view (durable + log-derived + liveness)
// ============================================================================

export const StreamSnapshotSchema = SharedBackendOwnedFieldsSchema.extend({
  /**
   * Missing on legacy assemblies/exports → current version; a PRESENT wrong
   * version fails the parse loudly (`.prefault`, not `.catch` — a swallowed
   * future version would consume unknown-shaped fields as v1).
   */
  schemaVersion: z
    .literal(STREAM_SNAPSHOT_SCHEMA_VERSION)
    .prefault(STREAM_SNAPSHOT_SCHEMA_VERSION),
  streamId: StreamTabIdSchema,

  // -- Durable display state (persisted in field-scoped files) --------------
  todos: WorkPlanSnapshotShape.todos.prefault([]),
  plan: WorkPlanSnapshotShape.plan.prefault(null),
  planSummary: WorkPlanSnapshotShape.planSummary.prefault(null),
  // Round-keyed records match the on-disk JSON: string keys → arrays. Value
  // schemas shared with the live WorkflowStreamStateSchema (see
  // RoundKeyedOutputSidecarValueSchemas) so the two can't drift.
  outputFilesByRound: RoundKeyedOutputSidecarValueSchemas.outputFiles.prefault(
    {},
  ),
  missingOutputsByRound:
    RoundKeyedOutputSidecarValueSchemas.missingOutputs.prefault({}),
  compileFailuresByRound:
    RoundKeyedOutputSidecarValueSchemas.compileFailures.prefault({}),
  runUsage: RunUsageMapSchema.prefault({}),

  // -- Pointers (resume / lookup) -------------------------------------------
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: StreamTabIdSchema.optional(),

  // -- Log-derived (recomputed from the StreamLog on load) ------------------
  status: StreamPhaseSchema.optional(),
  // conversationProgress comes from SharedBackendOwnedFieldsSchema above.

  // -- Liveness (NEVER restored as live — clamp on hydrate) -----------------
  // subagents comes from SharedBackendOwnedFieldsSchema.
});

export type StreamSnapshot = z.infer<typeof StreamSnapshotSchema>;
