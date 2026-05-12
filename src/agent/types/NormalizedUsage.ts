/**
 * Unified usage statistics - the ONLY type used after API response extraction.
 * All model handlers normalize their provider-specific usage to this format.
 */
import { z } from 'zod';

import { TokenUsageStatsSchema } from '@shared/schemas';

/** Provider identifiers for usage tracking. */
export const UsageProviderSchema = z.enum([
  'anthropic',
  'openai',
  'openai-response',
  'google',
  'deepseek',
  'openrouter',
  'dashscope',
  'xai',
  'moonshot',
  'minimax',
  'glm',
  'unknown',
]);

export type UsageProvider = z.infer<typeof UsageProviderSchema>;

/** Normalized usage statistics from any model provider. */
export const NormalizedUsageSchema = TokenUsageStatsSchema.extend({
  /** Response time in milliseconds */
  responseTimeMs: z.number(),
  /** Provider that generated this usage data */
  provider: UsageProviderSchema,

  // Optional metrics (when supported by provider)
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens: z.number().optional(),
  /** Tokens that missed provider prompt cache and were billed at full input rate */
  cacheMissInputTokens: z.number().optional(),
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
