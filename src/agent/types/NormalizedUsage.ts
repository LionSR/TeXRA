/**
 * Unified usage statistics - the ONLY type used after API response extraction.
 * All model handlers normalize their provider-specific usage to this format.
 *
 * This provides a single source of truth for usage tracking across all providers.
 */

/**
 * Provider identifiers for usage tracking.
 */
export type UsageProvider =
  | 'anthropic'
  | 'openai'
  | 'openai-response'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'dashscope'
  | 'xai'
  | 'kimi'
  | 'unknown';

/**
 * Normalized usage statistics from any model provider.
 * Cost is computed once during normalization and never recomputed.
 */
export interface NormalizedUsage {
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens generated */
  outputTokens: number;
  /** Total cost in USD (computed once, never recomputed) */
  cost: number;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** Provider that generated this usage data */
  provider: UsageProvider;

  // Optional metrics (when supported by provider)
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens?: number;
  /** Tokens written to cache - Anthropic only (increases cost by 1.25x) */
  cacheCreationTokens?: number;
  /** Percentage of input tokens served from cache */
  percentageCached?: number;
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens?: number;
  /** Tokens consumed by tool use prompts (Google) */
  toolUsePromptTokens?: number;
  /** Number of server-side tool executions (Anthropic web search) */
  serverToolRequests?: number;
  /** Original API response payload (for debugging) */
  _native?: unknown;
}
