/**
 * Google GenAI usage accounting & pricing.
 *
 * Pure functions extracted from `ModelHandlerGoogleGenAI` so token accounting
 * and price computation can be reasoned about and unit-tested without a live
 * handler instance. The handler keeps thin `computePrice` / `normalizeUsage`
 * overrides that delegate here with the model's pricing config.
 *
 * The token model is shared with the Interactions API (`googleInteractionsUsage.ts`).
 * Both surfaces report the same semantics with different field names (camelCase
 * `GenerateContentResponseUsageMetadata` here vs. snake_case `Interactions.Usage`
 * there), so the math lives once in {@link computeGooglePriceFromFields} /
 * {@link normalizeGoogleUsageFromFields} and each surface supplies only a
 * {@link GoogleUsageFields} accessor.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  computeStandardPrice,
  type StandardPricingConfig,
} from '@agent/utils/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';

/** Pricing inputs the handler supplies from its `config`/`capabilities`. */
export type GooglePricingConfig = StandardPricingConfig;

/**
 * Maps a provider-specific usage payload onto the unified Google token model.
 *
 * Both Google surfaces (chat `generateContent` and the Interactions API) report
 * the same quantities under different field names; an implementation of this
 * interface is the only thing that varies between them.
 */
export interface GoogleUsageFields<U> {
  /** Prompt/input tokens (chat `promptTokenCount` / interactions `total_input_tokens`). */
  promptTokens(usage: U): number;
  /** Tool-use prompt tokens (`toolUsePromptTokenCount` / `total_tool_use_tokens`). */
  toolUseTokens(usage: U): number;
  /** Visible model output, excluding thoughts (`candidatesTokenCount` / `total_output_tokens`). */
  visibleOutputTokens(usage: U): number;
  /** Reasoning/thought tokens (`thoughtsTokenCount` / `total_thought_tokens`). */
  reasoningTokens(usage: U): number;
  /** Grand total, used to derive output when the direct fields are unpopulated. */
  totalTokens(usage: U): number | undefined;
  /** Cached-read tokens, a subset of input (`cachedContentTokenCount` / `total_cached_tokens`). */
  cachedTokens(usage: U): number;
}

interface GoogleTokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * Google token totals. Output prefers visible output + reasoning
 * (candidatesTokenCount excludes thinking tokens per llm-gemini#75); when those
 * fields are unpopulated (some models in streaming) it derives output from
 * totalTokenCount - inputTokens.
 *
 * TODO: extract per-modality token breakdown from promptTokensDetails[],
 * candidatesTokensDetails[], cacheTokensDetails[], toolUsePromptTokensDetails[]
 * (ModalityTokenCount: TEXT/IMAGE/VIDEO/AUDIO/DOCUMENT; PDF pages report under
 * IMAGE, not DOCUMENT) for modality-specific cost tracking.
 */
function computeGoogleTokenCounts<U>(
  usage: U | null,
  fields: GoogleUsageFields<U>,
): GoogleTokenCounts {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  }

  const inputTokens = fields.promptTokens(usage) + fields.toolUseTokens(usage);
  const reasoningTokens = fields.reasoningTokens(usage);

  // Per Google's formula: outputTokens = visible output + thoughts.
  // When these fields are populated, use them directly.
  // When unpopulated (some models in streaming), derive from the grand total.
  const directOutput = fields.visibleOutputTokens(usage) + reasoningTokens;
  const total = fields.totalTokens(usage);
  const derivedOutput =
    total !== undefined ? Math.max(0, total - inputTokens) : 0;

  // Use direct values when available; otherwise use derived calculation
  const outputTokens = directOutput > 0 ? directOutput : derivedOutput;

  return { inputTokens, outputTokens, reasoningTokens };
}

/**
 * Shared price computation for any Google usage shape.
 *
 * No reasoning surcharge: thought tokens are already part of outputTokens.
 * Cached reads are a subset of input, so they are billed at the full input rate
 * and rebated by `computeStandardPrice`.
 */
export function computeGooglePriceFromFields<U>(
  responseUsage: U | null,
  config: GooglePricingConfig,
  fields: GoogleUsageFields<U>,
): number {
  if (!responseUsage) return 0.0;
  const { inputTokens, outputTokens } = computeGoogleTokenCounts(
    responseUsage,
    fields,
  );

  return computeStandardPrice(
    {
      inputTokens,
      outputTokens,
      cachedTokens: fields.cachedTokens(responseUsage),
    },
    config,
  );
}

/** Shared usage normalization for any Google usage shape. */
export function normalizeGoogleUsageFromFields<U>(
  rawUsage: U | null,
  responseTimeMs: number,
  config: GooglePricingConfig,
  fields: GoogleUsageFields<U>,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider: 'google',
      computePrice: (usage) =>
        computeGooglePriceFromFields(usage, config, fields),
      extract: (usage) => {
        const { inputTokens, outputTokens, reasoningTokens } =
          computeGoogleTokenCounts(usage, fields);
        return {
          inputTokens,
          outputTokens,
          cachedTokens: fields.cachedTokens(usage),
          reasoningTokens,
          toolUsePromptTokens: fields.toolUseTokens(usage),
        };
      },
    },
    rawUsage,
    responseTimeMs,
  );
}

/** Field accessors for the camelCase chat (`generateContent`) usage shape. */
const CHAT_USAGE_FIELDS: GoogleUsageFields<GenerateContentResponseUsageMetadata> =
  {
    promptTokens: (usage) => usage.promptTokenCount ?? 0,
    toolUseTokens: (usage) => usage.toolUsePromptTokenCount ?? 0,
    visibleOutputTokens: (usage) => usage.candidatesTokenCount ?? 0,
    reasoningTokens: (usage) => usage.thoughtsTokenCount ?? 0,
    totalTokens: (usage) => usage.totalTokenCount,
    cachedTokens: (usage) => usage.cachedContentTokenCount ?? 0,
  };

/** Computes cost based on token usage and model pricing. */
export function computeGooglePrice(
  responseUsage: GenerateContentResponseUsageMetadata | null,
  config: GooglePricingConfig,
): number {
  return computeGooglePriceFromFields(responseUsage, config, CHAT_USAGE_FIELDS);
}

/** Normalizes Google GenAI usage data into a unified format. */
export function normalizeGoogleUsage(
  rawUsage: GenerateContentResponseUsageMetadata | null,
  responseTimeMs: number,
  config: GooglePricingConfig,
): NormalizedUsage {
  return normalizeGoogleUsageFromFields(
    rawUsage,
    responseTimeMs,
    config,
    CHAT_USAGE_FIELDS,
  );
}
