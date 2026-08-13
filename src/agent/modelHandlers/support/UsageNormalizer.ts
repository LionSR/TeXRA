/**
 * Generic, config-driven token-usage normalization shared by model handlers.
 *
 * Every provider's `normalizeUsage()` follows the same shape: null-check the
 * raw usage object, extract input/output/cache/reasoning token counts from
 * provider-specific fields, compute the cache percentage, compute price, and
 * assemble a {@link NormalizedUsage}. The only thing that differs between
 * providers is *where* those values live in the raw usage object (and a few
 * provider-only extras such as Anthropic's cache-creation/server-tool fields or
 * Google's tool-use prompt tokens).
 *
 * {@link normalizeUsage} captures that common assembly once; each handler
 * supplies a small {@link UsageNormalizerConfig} describing how to read the
 * fields. Behavior is intentionally byte-identical to the previous per-handler
 * implementations — see the field mappings in each handler for details.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

/**
 * Calculate cache percentage from cached and total input tokens. Returns
 * undefined when no caching occurred (so a 0 is never stored).
 */
function computeCachePercentage(
  cachedTokens: number,
  totalInputTokens: number,
): number | undefined {
  if (totalInputTokens <= 0 || cachedTokens <= 0) return undefined;
  return (cachedTokens / totalInputTokens) * 100;
}

/**
 * Token counts extracted from a provider's raw usage object.
 *
 * `cachePercentageBasis` is the numerator passed to
 * {@link computeCachePercentage}; for most providers it equals `cachedTokens`,
 * but Anthropic counts both cache-read and cache-creation tokens.
 *
 * `inputTokens` is the denominator for the cache percentage and the value
 * surfaced as `NormalizedUsage.inputTokens`.
 */
interface ExtractedUsageTokens {
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

/**
 * Per-provider configuration for {@link normalizeUsage}.
 *
 * `T` is the provider's raw usage type (nullable for providers whose extractor
 * already tolerates a null payload).
 */
interface UsageNormalizerConfig<T> {
  /** Usage-tracking provider identifier. */
  provider: NormalizedUsage['provider'];
  /** Reads provider-specific token counts from the raw usage object. */
  extract: (rawUsage: NonNullable<T>) => ExtractedUsageTokens;
  /** Computes API cost for the raw usage object. */
  computePrice: (rawUsage: NonNullable<T>) => number;
}

/** Builds a {@link NormalizedUsage} from a provider config and raw usage. */
export function normalizeUsage<T>(
  config: UsageNormalizerConfig<T>,
  rawUsage: T,
  responseTimeMs: number,
): NormalizedUsage {
  if (!rawUsage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      responseTimeMs,
      provider: config.provider,
    };
  }

  const raw = rawUsage as NonNullable<T>;
  const tokens = config.extract(raw);
  const cacheBasis = tokens.cachePercentageBasis ?? tokens.cachedTokens;

  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cost: config.computePrice(raw),
    responseTimeMs,
    provider: config.provider,
    cachedInputTokens: tokens.cachedTokens || undefined,
    cacheMissInputTokens: tokens.cacheMissTokens || undefined,
    cacheCreationTokens: tokens.cacheCreationTokens || undefined,
    percentageCached: computeCachePercentage(cacheBasis, tokens.inputTokens),
    reasoningTokens: tokens.reasoningTokens || undefined,
    toolUsePromptTokens: tokens.toolUsePromptTokens || undefined,
    serverToolRequests: tokens.serverToolRequests || undefined,
    _native: raw,
  };
}
