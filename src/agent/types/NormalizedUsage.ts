/**
 * Unified usage statistics - the ONLY type used after API response extraction.
 * All model handlers normalize their provider-specific usage to this format.
 *
 * This provides a single source of truth for usage tracking across all providers.
 */
import { z } from 'zod';

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
 * Schema for applied context edits from the API response.
 * Captures details about which context editing strategies were applied.
 */
export const AppliedContextEditSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('clear_tool_uses_20250919'),
    /** Number of tool use/result pairs that were cleared */
    clearedToolUses: z.number().optional(),
    /** Number of input tokens that were cleared */
    clearedInputTokens: z.number().optional(),
  }),
  z.object({
    type: z.literal('clear_thinking_20251015'),
    /** Number of thinking turns that were cleared */
    clearedThinkingTurns: z.number().optional(),
    /** Number of input tokens that were cleared */
    clearedInputTokens: z.number().optional(),
  }),
]);

export type AppliedContextEdit = z.infer<typeof AppliedContextEditSchema>;

/**
 * Schema for context editing information in usage data.
 */
export const ContextEditsInfoSchema = z.object({
  /** List of context edits that were applied */
  appliedEdits: z.array(AppliedContextEditSchema),
  /** Total tokens cleared across all strategies */
  totalClearedTokens: z.number().optional(),
});

export type ContextEditsInfo = z.infer<typeof ContextEditsInfoSchema>;

/**
 * Normalized usage statistics from any model provider.
 * Cost is computed once during normalization and never recomputed.
 */
export const NormalizedUsageSchema = z.object({
  /** Total input tokens consumed */
  inputTokens: z.number(),
  /** Total output tokens generated */
  outputTokens: z.number(),
  /** Total cost in USD (computed once, never recomputed) */
  cost: z.number(),
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
  /** Context editing information - edits applied to manage context size */
  contextEdits: ContextEditsInfoSchema.optional(),
  /** Original API response payload (for debugging) */
  _native: z.unknown().optional(),
});

export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;
