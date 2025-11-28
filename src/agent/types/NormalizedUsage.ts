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
  // ─── Core metrics (always present) ───────────────────────────────────────
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens generated */
  outputTokens: number;
  /** Total cost in USD (computed once, never recomputed) */
  cost: number;
  /** Response time in milliseconds */
  responseTimeMs: number;

  // ─── Provider identification ─────────────────────────────────────────────
  /** Provider that generated this usage data */
  provider: UsageProvider;

  // ─── Caching metrics (when supported) ────────────────────────────────────
  /** Tokens served from cache (reduces cost) */
  cachedInputTokens?: number;
  /** Tokens written to cache - Anthropic only (increases cost by 1.25x) */
  cacheCreationTokens?: number;
  /** Percentage of input tokens served from cache */
  percentageCached?: number;

  // ─── Advanced metrics (when available) ───────────────────────────────────
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens?: number;
  /** Tokens consumed by server-side tool execution */
  toolUseTokens?: number;

  // ─── Raw payload for debugging ───────────────────────────────────────────
  /** Original API response payload (optional, for debugging) */
  _native?: unknown;
}

/**
 * Minimal usage for UI display.
 */
export type UsageDisplay = Pick<
  NormalizedUsage,
  'inputTokens' | 'outputTokens' | 'cost'
>;

/**
 * Extended usage for logs and detailed views (excludes raw payload).
 */
export type UsageExtended = Omit<NormalizedUsage, '_native'>;

/**
 * Creates an empty/zero usage object.
 */
export function createEmptyUsage(provider: UsageProvider): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    responseTimeMs: 0,
    provider,
  };
}

/**
 * Extracts display-only fields from normalized usage.
 */
export function toUsageDisplay(usage: NormalizedUsage): UsageDisplay {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: usage.cost,
  };
}

/**
 * Extracts extended fields (without native payload) from normalized usage.
 */
export function toUsageExtended(usage: NormalizedUsage): UsageExtended {
  const { _native, ...extended } = usage;
  return extended;
}
