/**
 * `StreamSnapshot` — the unified, host-agnostic per-stream render/resume shape.
 *
 * One logical schema that the CLI TUI, VS Code extension progress view, and
 * Electron desktop app all render and resume from. It is **not** one physical
 * file: it is persisted across the field-scoped `streamData/{id}/*` files (see
 * `@transcript/streamDataPaths`) and assembled on read by `StreamSnapshotStore`.
 *
 * Fields fall into three deliberately-separated classes (conflating them is what
 * produces lying UIs and double-writes):
 *
 *  - **Durable** — persisted to disk; restored verbatim on resume. The only
 *    genuinely new durable state is todos/plan/planSummary (ephemeral in every
 *    host today, not in the StreamLog); output files / usage already persist.
 *  - **Log-derived** — recomputed from `StreamLogStore` (+ `ExecutionKVStore`)
 *    on load. The log wins; any persisted copy here is advisory only.
 *  - **Liveness** — runtime-only. NEVER restored as live: active children clamp
 *    to `[]` and an in-flight RUNNING status is never reasserted on hydrate.
 *
 * `taskState` (resume/continuation data) is intentionally NOT inlined here — it
 * stays in `streamData/{id}/meta.json`, handled where `@agent` is importable, so
 * this shared schema avoids a `src/shared → @agent` import cycle.
 */

import { z } from 'zod';

import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';
import { StreamStatusSchema } from './stream';
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

/**
 * Bump when the persisted shape changes. A reader enforces this as a
 * forward-compat gate in `readPersistedWorkPlan` (`@transcript/streamSnapshotRead`):
 * a file stamped with a NEWER version is ignored (read as empty) rather than
 * having its unknown-shaped fields consumed as this version.
 */
export const STREAM_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// Persisted workPlan.json — the one NEW durable file
// ============================================================================

/**
 * On-disk shape of `streamData/{id}/workPlan.json` — the strict reader/writer
 * for the one NEW durable file (todos/plan/planSummary have no other home). The
 * lenient {@link WorkPlanSnapshotSchema} (in `@shared/schemas/workPlan`) is a
 * deliberately separate role: it normalizes UNTRUSTED bus/agent input (deriving
 * planSummary from the plan), whereas this schema reads/writes our own trusted
 * disk format. `.catch` per field keeps one corrupt value from nuking the rest;
 * a missing/older `schemaVersion` is tolerated (treated as v1), while a NEWER
 * one is gated out upstream in `readPersistedWorkPlan` before this parse runs.
 */
export const PersistedWorkPlanSchema = z.object({
  schemaVersion: z
    .literal(STREAM_SNAPSHOT_SCHEMA_VERSION)
    .catch(STREAM_SNAPSHOT_SCHEMA_VERSION),
  todos: WorkPlanSnapshotShape.todos.catch([]),
  plan: WorkPlanSnapshotShape.plan.catch(null),
  planSummary: WorkPlanSnapshotShape.planSummary.catch(null),
});

// ============================================================================
// StreamSnapshot — the assembled logical view (durable + log-derived + liveness)
// ============================================================================

export const StreamSnapshotSchema = SharedBackendOwnedFieldsSchema.extend({
  schemaVersion: z
    .literal(STREAM_SNAPSHOT_SCHEMA_VERSION)
    .catch(STREAM_SNAPSHOT_SCHEMA_VERSION),
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
  /**
   * Legacy sidecar mirror only (#9590 Stage 6): current records carry their
   * description on `ExecutionMeta.description` (A4), which display readers use
   * — e.g. the trace viewer reads `trace.meta.description`. Populated here
   * only from a legacy sidecar that still holds the retired mirror field.
   */
  description: z.string().optional(),

  // -- Log-derived (recomputed from the StreamLog on load) ------------------
  status: StreamStatusSchema.optional(),
  // conversationProgress comes from SharedBackendOwnedFieldsSchema above.

  // -- Liveness (NEVER restored as live — clamp on hydrate) -----------------
  // subagents comes from SharedBackendOwnedFieldsSchema.
});

export type StreamSnapshot = z.infer<typeof StreamSnapshotSchema>;
