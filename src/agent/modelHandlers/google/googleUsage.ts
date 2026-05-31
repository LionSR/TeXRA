/**
 * Google GenAI usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerGoogleGenAI` so token accounting
 * and price computation can be reasoned about and unit-tested without a live
 * handler instance. The handler keeps thin `computePrice` / `normalizeUsage`
 * overrides that delegate here with the model's pricing config.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { calculateTokenPrice } from '@agent/utils/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';

/** Pricing inputs the handler supplies from its `config`. */
export interface GooglePricingConfig {
  inputPrice: number;
  outputPrice: number;
}

interface GoogleTokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * Google token totals. Output prefers candidatesTokenCount + thoughtsTokenCount
 * (candidatesTokenCount excludes thinking tokens per llm-gemini#75); when those
 * fields are unpopulated (some models in streaming) it derives output from
 * totalTokenCount - inputTokens.
 *
 * TODO: extract per-modality token breakdown from promptTokensDetails[],
 * candidatesTokensDetails[], cacheTokensDetails[], toolUsePromptTokensDetails[]
 * (ModalityTokenCount: TEXT/IMAGE/VIDEO/AUDIO/DOCUMENT; PDF pages report under
 * IMAGE, not DOCUMENT) for modality-specific cost tracking.
 */
function computeGoogleTokenCounts(
  usage: GenerateContentResponseUsageMetadata | null,
): GoogleTokenCounts {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  }

  const promptTokens = usage.promptTokenCount ?? 0;
  const toolUseTokens = usage.toolUsePromptTokenCount ?? 0;
  const candidatesTokens = usage.candidatesTokenCount ?? 0;
  const reasoningTokens = usage.thoughtsTokenCount ?? 0;

  const inputTokens = promptTokens + toolUseTokens;

  // Per Google's formula: outputTokens = candidatesTokenCount + thoughtsTokenCount
  // When these fields are populated, use them directly.
  // When unpopulated (some models in streaming), derive from totalTokenCount.
  const directOutput = candidatesTokens + reasoningTokens;
  const derivedOutput =
    usage.totalTokenCount !== undefined
      ? Math.max(0, usage.totalTokenCount - inputTokens)
      : 0;

  // Use direct values when available; otherwise use derived calculation
  const outputTokens = directOutput > 0 ? directOutput : derivedOutput;

  return { inputTokens, outputTokens, reasoningTokens };
}

/** Computes cost based on token usage and model pricing. */
export function computeGooglePrice(
  responseUsage: GenerateContentResponseUsageMetadata | null,
  config: GooglePricingConfig,
): number {
  if (!responseUsage) return 0.0;
  const { inputTokens, outputTokens } = computeGoogleTokenCounts(responseUsage);

  return calculateTokenPrice(
    inputTokens,
    outputTokens,
    config.inputPrice,
    config.outputPrice,
  );
}

/** Normalizes Google GenAI usage data into a unified format. */
export function normalizeGoogleUsage(
  rawUsage: GenerateContentResponseUsageMetadata | null,
  responseTimeMs: number,
  config: GooglePricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider: 'google',
      computePrice: (usage) => computeGooglePrice(usage, config),
      extract: (usage) => {
        const { inputTokens, outputTokens, reasoningTokens } =
          computeGoogleTokenCounts(usage);
        return {
          inputTokens,
          outputTokens,
          cachedTokens: usage.cachedContentTokenCount ?? 0,
          reasoningTokens,
          toolUsePromptTokens: usage.toolUsePromptTokenCount ?? 0,
        };
      },
    },
    rawUsage,
    responseTimeMs,
  );
}
