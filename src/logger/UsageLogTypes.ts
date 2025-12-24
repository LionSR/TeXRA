/**
 * Types and schemas for backend usage logging.
 *
 * Usage logs are sent to Supabase for:
 * - Usage analytics and statistics
 * - Future rate limiting support
 * - Cost tracking per user/model
 */
import { z } from 'zod';

import { UsageProviderSchema } from '@agent/types/NormalizedUsage';

/**
 * Single usage log entry sent to the backend.
 * Contains all relevant metadata for analytics and rate limiting.
 */
export const UsageLogEntrySchema = z.object({
  /** Timestamp when the API call completed (ISO 8601) */
  timestamp: z.string().datetime(),

  /** Model identifier (e.g., 'claude-sonnet-4-20250514', 'gpt-4o') */
  model: z.string(),

  /** Provider that handled the request */
  provider: UsageProviderSchema,

  /** Agent name that initiated the request */
  agentName: z.string().optional(),

  /** Agent category: workflow or toolUse */
  agentCategory: z.enum(['workflow', 'toolUse']).optional(),

  /** Whether this is a multiple-output workflow agent */
  isMultipleOutput: z.boolean().optional(),

  /** Number of input tokens consumed */
  inputTokens: z.number().int().nonnegative(),

  /** Number of output tokens generated */
  outputTokens: z.number().int().nonnegative(),

  /** Computed cost in USD */
  cost: z.number().nonnegative(),

  /** Response time in milliseconds */
  responseTimeMs: z.number().nonnegative().optional(),

  /** Tokens served from cache */
  cachedInputTokens: z.number().int().nonnegative().optional(),

  /** Tokens used for reasoning (o1, DeepSeek-R1, etc.) */
  reasoningTokens: z.number().int().nonnegative().optional(),

  /** Whether the request used server-side API keys (relay) */
  usedRelay: z.boolean().optional(),

  /** Stream/session identifier for grouping related requests */
  streamId: z.string().optional(),

  /** Extension version for debugging */
  extensionVersion: z.string().optional(),
});

export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

/**
 * Batch payload sent to the log-usage edge function.
 */
export const UsageLogBatchSchema = z.object({
  /** Array of usage log entries */
  entries: z.array(UsageLogEntrySchema),

  /** Client-generated batch ID for deduplication */
  batchId: z.string().uuid(),
});

export type UsageLogBatch = z.infer<typeof UsageLogBatchSchema>;

/**
 * Response from the log-usage edge function.
 * Includes quota information for future rate limiting.
 */
export const UsageLogResponseSchema = z.object({
  /** Whether the batch was successfully logged */
  success: z.boolean(),

  /** Number of entries accepted */
  accepted: z.number().int().nonnegative(),

  /** Error message if any entries failed */
  error: z.string().optional(),

  /** Quota information for rate limiting (future use) */
  quota: z
    .object({
      /** Daily cost limit in USD */
      dailyLimit: z.number().optional(),

      /** Cost used today in USD */
      dailyUsed: z.number().optional(),

      /** Remaining daily allowance */
      dailyRemaining: z.number().optional(),

      /** Monthly cost limit in USD */
      monthlyLimit: z.number().optional(),

      /** Cost used this month in USD */
      monthlyUsed: z.number().optional(),

      /** Whether the user is rate limited */
      isLimited: z.boolean().optional(),

      /** When rate limit resets (ISO 8601) */
      resetsAt: z.string().datetime().optional(),
    })
    .optional(),
});

export type UsageLogResponse = z.infer<typeof UsageLogResponseSchema>;
