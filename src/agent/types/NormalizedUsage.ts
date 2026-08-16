/**
 * Unified usage statistics - the ONLY type used after API response extraction.
 * All model handlers normalize their provider-specific usage to this format.
 */
import { z } from 'zod';

import {
  TokenCountSchema,
  TokenUsageStatsBaseSchema,
  UsageProviderSchema,
  UsageRouteSchema,
} from '@shared/schemas';

/**
 * Normalized usage statistics from any model provider.
 *
 * Reuses only the required base fields via `.pick()` — the optional cache
 * fields on `TokenUsageStatsBaseSchema` (`cacheReadInputTokens` /
 * `cacheCreationInputTokens`) are never populated for a NormalizedUsage; the
 * live cache metrics below (`cachedInputTokens` / `cacheCreationTokens`) are
 * the authoritative names. Extending the full base instead would inherit
 * those dead fields and duplicate `cacheMissInputTokens`.
 */
const NormalizedUsageBaseSchema = TokenUsageStatsBaseSchema.pick({
  inputTokens: true,
  outputTokens: true,
  cost: true,
}).extend({
  /** Response time in milliseconds */
  responseTimeMs: z.number().nonnegative(),
  /** Provider that generated this usage data */
  provider: UsageProviderSchema,

  // Optional metrics (when supported by provider)
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens: TokenCountSchema.optional(),
  /** Tokens that missed provider prompt cache and were billed at full input rate */
  cacheMissInputTokens: TokenCountSchema.optional(),
  /** Tokens written to cache - Anthropic only (increases cost by 1.25x) */
  cacheCreationTokens: TokenCountSchema.optional(),
  /** Percentage of input tokens served from cache */
  percentageCached: z.number().nonnegative().optional(),
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens: TokenCountSchema.optional(),
  /** Tokens consumed by tool use prompts (Google) */
  toolUsePromptTokens: TokenCountSchema.optional(),
  /** Number of server-side tool executions (Anthropic web search) */
  serverToolRequests: TokenCountSchema.optional(),
  /** Canonical route used for usage display and telemetry. */
  usageRoute: UsageRouteSchema.optional(),
  /** Original API response payload (for debugging) */
  _native: z.unknown().optional(),
});

export const NormalizedUsageSchema = NormalizedUsageBaseSchema;

export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;
