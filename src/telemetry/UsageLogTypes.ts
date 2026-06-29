import { z } from 'zod';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { UsageProviderSchema } from '@agent/types/NormalizedUsage';

const UsageLogMetadataSchema = z.object({
  model: z.string(),
  provider: UsageProviderSchema,
  agentName: z.string().optional(),
  agentCategory: z.enum(AgentCategory).optional(),
  usedRelay: z.boolean().optional(),
  /**
   * True when the round ran on the user's ChatGPT subscription (Codex backend):
   * recorded so analytics can account for subscription usage even though its
   * `cost` is 0. Distinguishes a free subscription round from any other
   * zero-cost row.
   */
  viaChatGptSubscription: z.boolean().optional(),
  streamId: z.string().optional(),
});

const UsageLogStatsSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cost: z.number().nonnegative(),
  responseTimeMs: z.number().nonnegative().optional(),
  cachedInputTokens: z.int().nonnegative().optional(),
  cacheMissInputTokens: z.int().nonnegative().optional(),
  cacheCreationInputTokens: z.int().nonnegative().optional(),
  reasoningTokens: z.int().nonnegative().optional(),
});

export const UsageLogEntrySchema = UsageLogMetadataSchema.extend(
  UsageLogStatsSchema.shape,
).extend({
  timestamp: z.iso.datetime(),
  extensionVersion: z.string().optional(),
  editorType: z.string().optional(),
});

export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

export const UsageLogBatchSchema = z.object({
  entries: z.array(UsageLogEntrySchema),
  batchId: z.uuid(),
});

export type UsageLogBatch = z.infer<typeof UsageLogBatchSchema>;

export const UsageLogResponseSchema = z.object({
  success: z.boolean(),
  accepted: z.int().nonnegative(),
  error: z.string().optional(),
});

export type UsageLogResponse = z.infer<typeof UsageLogResponseSchema>;
