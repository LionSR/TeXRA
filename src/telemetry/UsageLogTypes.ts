import { z } from 'zod';

import { TurnProtocolSchema } from '@llm/turn';
import { AgentCategory, UsageRouteSchema } from '@shared/schemas';

const UsageLogMetadataSchema = z.object({
  model: z.string(),
  /** Wire surface of the turn (`openai-responses`, `anthropic-messages`, ...).
   * The edge function stores it in the `provider` column; the column takes
   * protocol names under the same versioning rule as the rest of this wire. */
  provider: TurnProtocolSchema,
  agentName: z.string().optional(),
  agentCategory: z.enum(AgentCategory).optional(),
  /** Canonical route used to account for API-key/subscription usage. */
  usageRoute: UsageRouteSchema.optional(),
  /** Wire key of the usage-log edge function (`supabase/functions/log-usage`), which
   * stores it as `stream_id`; the value is the run id. External contract, versioned
   * with the edge function, not with the run vocabulary. */
  streamId: z.string().optional(),
});

const UsageLogStatsSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cost: z.number().nonnegative(),
  responseTimeMs: z.number().nonnegative().optional(),
  cachedInputTokens: z.int().nonnegative().optional(),
  reasoningTokens: z.int().nonnegative().optional(),
});

/**
 * Field names here intentionally follow this wire schema, not
 * `NormalizedUsage`'s — this is the persisted/billing log contract, so
 * renaming fields isn't free. Callers building a log payload from
 * `NormalizedUsage` should type their intermediate object as (a `Pick` of)
 * `UsageLogStats` rather than hand-duplicating this field list.
 */
export type UsageLogStats = z.infer<typeof UsageLogStatsSchema>;

const UsageLogEntrySchema = UsageLogMetadataSchema.extend(
  UsageLogStatsSchema.shape,
).extend({
  timestamp: z.iso.datetime(),
  extensionVersion: z.string().optional(),
  editorType: z.string().optional(),
});

export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

const UsageLogBatchSchema = z.object({
  entries: z.array(UsageLogEntrySchema),
  batchId: z.uuid(),
});

export type UsageLogBatch = z.infer<typeof UsageLogBatchSchema>;

export const UsageLogResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    accepted: z.int().nonnegative(),
  }),
  z.object({
    success: z.literal(false),
    accepted: z.literal(0),
    error: z.string().optional(),
    /** Only an explicit false permits the client to discard instead of retry. */
    retryable: z.boolean().optional(),
  }),
]);

export type UsageLogResponse = z.infer<typeof UsageLogResponseSchema>;
