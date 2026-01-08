/**
 * Types and schemas for backend usage logging.
 *
 * Usage logs are sent to Supabase for:
 * - Usage analytics and statistics
 * - Future rate limiting support
 * - Cost tracking per user/model
 *
 * Schema organization:
 * - UsageLogMetadataSchema: Request context (agent, model, session)
 * - UsageLogStatsSchema: Token counts and cost metrics
 * - UsageLogEntrySchema: Full entry (metadata + stats + timestamps)
 */
import { z } from 'zod';

import { UsageProviderSchema } from '@agent/types/NormalizedUsage';

// =============================================================================
// Metadata Schema - Request context
// =============================================================================

/**
 * Metadata about the API request context.
 * Describes what agent/model made the request and how.
 */
export const UsageLogMetadataSchema = z.object({
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

  /** Whether the request used server-side API keys (relay) */
  usedRelay: z.boolean().optional(),

  /** Stream/session identifier for grouping related requests */
  streamId: z.string().optional(),
});

export type UsageLogMetadata = z.infer<typeof UsageLogMetadataSchema>;

// =============================================================================
// Stats Schema - Usage metrics
// =============================================================================

/**
 * Usage statistics for an API request.
 * Contains token counts, cost, and timing metrics.
 */
export const UsageLogStatsSchema = z.object({
  /** Number of input tokens consumed */
  inputTokens: z.int().nonnegative(),

  /** Number of output tokens generated */
  outputTokens: z.int().nonnegative(),

  /** Computed cost in USD */
  cost: z.number().nonnegative(),

  /** Response time in milliseconds */
  responseTimeMs: z.number().nonnegative().optional(),

  /** Tokens served from cache (discounted rate) */
  cachedInputTokens: z.int().nonnegative().optional(),

  /** Tokens written to cache (Anthropic: 1.25x cost) */
  cacheCreationInputTokens: z.int().nonnegative().optional(),

  /** Tokens used for reasoning (o1, DeepSeek-R1, etc.) */
  reasoningTokens: z.int().nonnegative().optional(),
});

export type UsageLogStats = z.infer<typeof UsageLogStatsSchema>;

// =============================================================================
// Entry Schema - Full log entry (composed)
// =============================================================================

/**
 * Single usage log entry sent to the backend.
 * Composed from metadata + stats + timestamp/version fields.
 */
export const UsageLogEntrySchema = UsageLogMetadataSchema.extend(
  UsageLogStatsSchema.shape,
).extend({
  /** Timestamp when the API call completed (ISO 8601) */
  timestamp: z.iso.datetime(),

  /** Extension version for debugging */
  extensionVersion: z.string().optional(),
});

export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

// =============================================================================
// Batch Schema - Transport payload
// =============================================================================

/**
 * Batch payload sent to the log-usage edge function.
 */
export const UsageLogBatchSchema = z.object({
  /** Array of usage log entries */
  entries: z.array(UsageLogEntrySchema),

  /** Client-generated batch ID for deduplication */
  batchId: z.uuid(),
});

export type UsageLogBatch = z.infer<typeof UsageLogBatchSchema>;

// =============================================================================
// Response Schema - Server response
// =============================================================================

/**
 * Response from the log-usage edge function.
 */
export const UsageLogResponseSchema = z.object({
  /** Whether the batch was successfully logged */
  success: z.boolean(),

  /** Number of entries accepted */
  accepted: z.int().nonnegative(),

  /** Error message if any entries failed */
  error: z.string().optional(),
});

export type UsageLogResponse = z.infer<typeof UsageLogResponseSchema>;
