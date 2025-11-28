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

  // ─── Reasoning metrics (when available) ──────────────────────────────────
  /** Tokens used for reasoning (o1, DeepSeek-R1, Gemini thinking) */
  reasoningTokens?: number;

  // ─── Tool usage metrics ──────────────────────────────────────────────────
  /**
   * Tokens consumed by tool use prompts (Google).
   * Note: This is the token count for tool descriptions/prompts.
   */
  toolUsePromptTokens?: number;

  /**
   * Number of server-side tool executions (Anthropic).
   * E.g., web search requests performed by Claude.
   * Note: This is a request count, not a token count.
   */
  serverToolRequests?: number;

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

/**
 * Aggregates multiple usage objects into one.
 * Useful for combining usage across rounds or sub-agents.
 */
export function aggregateUsage(
  usages: NormalizedUsage[],
  provider: UsageProvider = 'unknown',
): NormalizedUsage {
  if (usages.length === 0) {
    return createEmptyUsage(provider);
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let totalResponseTimeMs = 0;
  let totalCachedInputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalReasoningTokens = 0;
  let totalToolUsePromptTokens = 0;
  let totalServerToolRequests = 0;

  for (const usage of usages) {
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCost += usage.cost;
    totalResponseTimeMs += usage.responseTimeMs;
    totalCachedInputTokens += usage.cachedInputTokens ?? 0;
    totalCacheCreationTokens += usage.cacheCreationTokens ?? 0;
    totalReasoningTokens += usage.reasoningTokens ?? 0;
    totalToolUsePromptTokens += usage.toolUsePromptTokens ?? 0;
    totalServerToolRequests += usage.serverToolRequests ?? 0;
  }

  // Use the first usage's provider if all are the same, otherwise 'unknown'
  const firstProvider = usages[0].provider;
  const allSameProvider = usages.every((u) => u.provider === firstProvider);
  const resultProvider = allSameProvider ? firstProvider : provider;

  const percentageCached =
    totalInputTokens > 0
      ? (totalCachedInputTokens / totalInputTokens) * 100
      : 0;

  return {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cost: totalCost,
    responseTimeMs: totalResponseTimeMs,
    provider: resultProvider,
    cachedInputTokens: totalCachedInputTokens || undefined,
    cacheCreationTokens: totalCacheCreationTokens || undefined,
    percentageCached: percentageCached > 0 ? percentageCached : undefined,
    reasoningTokens: totalReasoningTokens || undefined,
    toolUsePromptTokens: totalToolUsePromptTokens || undefined,
    serverToolRequests: totalServerToolRequests || undefined,
  };
}
