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
import { OutputFileInfoSchema, CompileFailureSchema } from './output';
import { PlanSchema } from './plan';
import { StreamStatusSchema } from './stream';
import {
  ActiveChildInfoSchema,
  ConversationProgressSchema,
} from './streamState';
import { TodoItemSchema } from './todo';
import { TokenUsageStatsSchema } from './usage';

/** Bump when the persisted shape changes; a downgraded reader detect-and-ignores. */
export const STREAM_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// Round / run keyed records (match the on-disk JSON: string keys → arrays)
// ============================================================================

const OutputFilesByRoundSchema = z
  .record(z.string(), z.array(OutputFileInfoSchema))
  .prefault({});
const MissingOutputsByRoundSchema = z
  .record(z.string(), z.array(z.string()))
  .prefault({});
const CompileFailuresByRoundSchema = z
  .record(z.string(), z.array(CompileFailureSchema))
  .prefault({});
const RunUsageSchema = z.record(z.string(), TokenUsageStatsSchema).prefault({});

// ============================================================================
// Persisted workPlan.json — the one NEW durable file
// ============================================================================

/**
 * On-disk shape of `streamData/{id}/workPlan.json`. todos/plan/planSummary have
 * no other durable home. `.catch` per field keeps one corrupt value from
 * nuking the rest; a missing/older `schemaVersion` is tolerated (treated as v1).
 */
export const PersistedWorkPlanSchema = z.object({
  schemaVersion: z
    .literal(STREAM_SNAPSHOT_SCHEMA_VERSION)
    .catch(STREAM_SNAPSHOT_SCHEMA_VERSION),
  todos: z.array(TodoItemSchema).catch([]),
  plan: PlanSchema.nullable().catch(null),
  planSummary: z.string().nullable().catch(null),
});

export type PersistedWorkPlan = z.infer<typeof PersistedWorkPlanSchema>;

export function emptyPersistedWorkPlan(): PersistedWorkPlan {
  return {
    schemaVersion: STREAM_SNAPSHOT_SCHEMA_VERSION,
    todos: [],
    plan: null,
    planSummary: null,
  };
}

// ============================================================================
// StreamSnapshot — the assembled logical view (durable + log-derived + liveness)
// ============================================================================

export const StreamSnapshotSchema = z.object({
  schemaVersion: z
    .literal(STREAM_SNAPSHOT_SCHEMA_VERSION)
    .catch(STREAM_SNAPSHOT_SCHEMA_VERSION),
  streamId: StreamTabIdSchema,

  // -- Durable display state (persisted in field-scoped files) --------------
  todos: z.array(TodoItemSchema).prefault([]),
  plan: PlanSchema.nullable().prefault(null),
  planSummary: z.string().nullable().prefault(null),
  outputFilesByRound: OutputFilesByRoundSchema,
  missingOutputsByRound: MissingOutputsByRoundSchema,
  compileFailuresByRound: CompileFailuresByRoundSchema,
  runUsage: RunUsageSchema,

  // -- Pointers (resume / lookup) -------------------------------------------
  executionId: ExecutionIdSchema.optional(),
  parentStreamId: StreamTabIdSchema.optional(),
  description: z.string().optional(),

  // -- Log-derived (recomputed from the StreamLog on load) ------------------
  status: StreamStatusSchema.optional(),
  conversationProgress: ConversationProgressSchema.prefault({}),
  finishedSubagentCount: z.number().prefault(0),
  finishedProcessCount: z.number().prefault(0),

  // -- Liveness (NEVER restored as live — clamp on hydrate) -----------------
  activeSubagents: z.array(ActiveChildInfoSchema).prefault([]),
  activeProcesses: z.array(ActiveChildInfoSchema).prefault([]),
});

export type StreamSnapshot = z.infer<typeof StreamSnapshotSchema>;

/** A minimal valid snapshot for a stream with no persisted sidecar yet. */
export function emptyStreamSnapshot(streamId: string): StreamSnapshot {
  return StreamSnapshotSchema.parse({ streamId });
}
