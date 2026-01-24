/**
 * Unified usage statistics - the ONLY type used after API response extraction.
 * All model handlers normalize their provider-specific usage to this format.
 *
 * This provides a single source of truth for usage tracking across all providers.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import { TokenUsageStatsSchema } from '@shared/schemas';

/**
 * Provider identifiers for usage tracking - single source of truth.
 */
export const UsageProviderSchema = z.enum([
  'anthropic',
  'openai',
  'openai-response',
  'google',
  'deepseek',
  'openrouter',
  'dashscope',
  'xai',
  'kimi',
  'unknown',
]);

export type UsageProvider = z.infer<typeof UsageProviderSchema>;

/**
 * Normalized usage statistics from any model provider.
 * Extends TokenUsageStatsSchema (single source of truth) with provider-specific fields.
 * Cost is computed once during normalization and never recomputed.
 */
export const NormalizedUsageSchema = TokenUsageStatsSchema.extend({
  /** Response time in milliseconds */
  responseTimeMs: z.number(),
  /** Provider that generated this usage data */
  provider: UsageProviderSchema,

  // Optional metrics (when supported by provider)
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens: z.number().optional(),
  /** Tokens written to cache - Anthropic only (increases cost by 1.25x) */
  cacheCreationTokens: z.number().optional(),
  /** Percentage of input tokens served from cache */
  percentageCached: z.number().optional(),
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens: z.number().optional(),
  /** Tokens consumed by tool use prompts (Google) */
  toolUsePromptTokens: z.number().optional(),
  /** Number of server-side tool executions (Anthropic web search) */
  serverToolRequests: z.number().optional(),
  /** Original API response payload (for debugging) */
  _native: z.unknown().optional(),
});

export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;
