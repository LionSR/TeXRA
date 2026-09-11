/** Assemble provider-neutral usage from counts and cost already computed by the provider. */

import type { NormalizedUsage } from '@shared/schemas';

/** Counts and cost derived from one provider usage object. */
interface UsageValues {
  rawUsage: unknown;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from cache. Surfaced as `cachedInputTokens` when > 0. */
  cachedTokens: number;
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

  return {
    inputTokens: values.inputTokens,
    outputTokens: values.outputTokens,
    cost: values.cost,
    responseTimeMs,
    provider,
    cachedInputTokens: values.cachedTokens || undefined,
    cacheMissInputTokens: values.cacheMissTokens || undefined,
    cacheCreationTokens: values.cacheCreationTokens || undefined,
    reasoningTokens: values.reasoningTokens || undefined,
    toolUsePromptTokens: values.toolUsePromptTokens || undefined,
    serverToolRequests: values.serverToolRequests || undefined,
  };
}
