import { z } from 'zod';

import { RunRecordSchema } from '@agent/core/definition/RunRecord';
import {
  CommitOrdinalSchema,
  ConversationProgressSchema,
  FlowStepPayloadSchema,
  PlanSchema,
  RoundKeyedOutputSidecarValueSchemas,
  RunIdSchema,
  RunIdentitySchema,
  RunOutcomeSchema,
  StreamLogEntrySchema,
  TodoItemSchema,
  TokenUsageStatsSchema,
} from '@shared/schemas';

/**
 * The run's listing facts as the fold held them at export: a projection of
 * `RunView` (one run model, R3), which the viewer replays as listing rows so
 * the same fold folds them to the same view. Every field is one the viewer
 * paints; the transcript tier travels as `entries`.
 */
const TraceRunFactsSchema = z.object({
  identity: RunIdentitySchema,
  /** `RunView.launchedAt`: ms since the epoch. */
  launchedAt: z.int().positive(),
  description: z.string().nullable(),
  /** The terminal status, or null for a run exported before it reached one. */
  outcome: RunOutcomeSchema.nullable(),
  conversationProgress: ConversationProgressSchema,
  usage: TokenUsageStatsSchema,
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  outputs: RoundKeyedOutputSidecarValueSchemas.outputFiles,
  missingOutputs: RoundKeyedOutputSidecarValueSchemas.missingOutputs,
  compileFailures: RoundKeyedOutputSidecarValueSchemas.compileFailures,
});

/**
 * One `flow.step` row of the run, as the ledger committed it: the viewer's
 * scrubber keys on `commit` (the database-wide ordinal, never the renumbered
 * `StreamLogEntry.seqNo`), cuts the transcript at `at` (the publish clock
 * every transcript row of the run is stamped with), and replays `payload`
 * through the same fold arm the live hosts run, so "state at step k" is the
 * fold's own reading (runtime on Effect, 2.3).
 */
const TraceStepSchema = z.object({
  commit: CommitOrdinalSchema,
  at: z.int(),
  payload: FlowStepPayloadSchema,
});

/** Everything a static trace viewer needs to replay one finished run. */
export const TraceDocumentSchema = z.object({
  runId: RunIdSchema,
  /** The run's honest record: AgentConfig for agent runs, minimal otherwise. */
  config: RunRecordSchema,
  meta: TraceRunFactsSchema,
  /** Transcript entries, exactly as the run recorded them. */
  entries: z.array(StreamLogEntrySchema),
  /** The run's `flow.step` rows in commit order; empty for a run whose loop
   *  never stepped (a process run, a workflow container). */
  steps: z.array(TraceStepSchema),
});

export type TraceDocument = Readonly<z.infer<typeof TraceDocumentSchema>>;
