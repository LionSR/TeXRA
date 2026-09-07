/** Assemble provider-neutral usage from counts and cost already computed by the provider. */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

/**
 * Counts and cost derived from one provider usage object.
 *
 * `cachePercentageBasis` usually equals `cachedTokens`, but Anthropic counts
 * both cache-read and cache-creation tokens.
 *
 * `inputTokens` is the denominator for the cache percentage and the value
 * surfaced as `NormalizedUsage.inputTokens`.
 */
interface UsageValues {
  rawUsage: unknown;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from cache. Surfaced as `cachedInputTokens` when > 0. */
  cachedTokens: number;
  /** Numerator for the cache percentage (defaults to `cachedTokens`). */
  cachePercentageBasis?: number;
  /** Tokens that missed the prompt cache (OpenAI/DeepSeek). */
  cacheMissTokens?: number;
  /** Tokens written to cache (Anthropic). */
  cacheCreationTokens?: number;
  /** Reasoning/thinking tokens. */
  reasoningTokens?: number;
  /** Tool-use prompt tokens (Google). */
  toolUsePromptTokens?: number;
  /** Number of server-side tool executions (Anthropic web search/fetch). */
  serverToolRequests?: number;
}

/** Builds a {@link NormalizedUsage}; absent usage has no optional metadata. */
export function normalizeUsage(
  provider: NormalizedUsage['provider'],
  responseTimeMs: number,
  values: UsageValues | null,
): NormalizedUsage {
  if (!values) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      responseTimeMs,
      provider,
    };
  }

  const cacheBasis = values.cachePercentageBasis ?? values.cachedTokens;

  return {
    inputTokens: values.inputTokens,
    outputTokens: values.outputTokens,
    cost: values.cost,
    responseTimeMs,
    provider,
    cachedInputTokens: values.cachedTokens || undefined,
    cacheMissInputTokens: values.cacheMissTokens || undefined,
    cacheCreationTokens: values.cacheCreationTokens || undefined,
    percentageCached:
      values.inputTokens <= 0 || cacheBasis <= 0
        ? undefined
        : (cacheBasis / values.inputTokens) * 100,
    reasoningTokens: values.reasoningTokens || undefined,
    toolUsePromptTokens: values.toolUsePromptTokens || undefined,
    serverToolRequests: values.serverToolRequests || undefined,
    _native: values.rawUsage,
  };
}
