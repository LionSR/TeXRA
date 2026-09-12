import { z } from 'zod';

import { RunRecordSchema } from '@agent/core/definition/RunRecord';
import {
  ConversationProgressSchema,
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

/** Everything a static trace viewer needs to replay one finished run. */
export const TraceDocumentSchema = z.object({
  runId: RunIdSchema,
  /** The run's honest record: AgentConfig for agent runs, minimal otherwise. */
  config: RunRecordSchema,
  meta: TraceRunFactsSchema,
  /** Transcript entries, exactly as the run recorded them. */
  entries: z.array(StreamLogEntrySchema),
});

export type TraceDocument = Readonly<z.infer<typeof TraceDocumentSchema>>;
