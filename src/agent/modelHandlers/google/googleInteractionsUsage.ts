/**
 * Google Interactions API usage accounting & pricing.
 *
 * The Interactions API reports usage with snake_case totals
 * ({@link Interactions.Usage}) that differ from the camelCase
 * `GenerateContentResponseUsageMetadata` the chat handler reads. These pure
 * functions mirror `googleUsage.ts` (the chat equivalent) against the snake_case
 * shape, then reuse the same shared price/normalize machinery
 * (`computeStandardPrice` / `normalizeUsage`) — no pricing logic is duplicated.
 *
 * The handler keeps thin `computePrice` / `normalizeUsage` overrides that
 * delegate here with the model's pricing config.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { computeStandardPrice } from '@agent/utils/priceUtils';

import { normalizeUsage } from '../support/UsageNormalizer';
import type { Interactions } from '@google/genai';
import type { GooglePricingConfig } from './googleUsage';

type InteractionsUsage = Interactions.Usage;

interface InteractionsTokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * Interactions token totals.
 *
 * Mirrors the chat formula `outputTokens = candidatesTokenCount +
 * thoughtsTokenCount`: the Interactions `total_output_tokens` is the visible
 * model output (excluding thoughts), and `total_thought_tokens` is reasoning, so
 * the unified output total is their sum. This keeps reasoning tokens billed once
 * (at the output rate via `outputTokens`) and never double-counts them — the
 * shared `computeStandardPrice` is called WITHOUT a separate `reasoningTokens`
 * surcharge, exactly as the chat handler does.
 *
 * Input mirrors chat's `promptTokenCount + toolUsePromptTokenCount`:
 * `total_input_tokens + total_tool_use_tokens`.
 *
 * NOTE: whether `total_output_tokens` already includes thoughts is documented
 * ambiguously upstream; a real-key smoke test should confirm before relying on
 * billing accuracy (spec §6.5). If the API ever folds thoughts into
 * `total_output_tokens`, drop the `+ reasoningTokens` term here.
 */
function computeInteractionsTokenCounts(
  usage: InteractionsUsage | null,
): InteractionsTokenCounts {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  }

  const promptTokens = usage.total_input_tokens ?? 0;
  const toolUseTokens = usage.total_tool_use_tokens ?? 0;
  const visibleOutputTokens = usage.total_output_tokens ?? 0;
  const reasoningTokens = usage.total_thought_tokens ?? 0;

  const inputTokens = promptTokens + toolUseTokens;

  // Per Google's formula: output = visible output + thoughts. When the totals
  // are unpopulated (some models in streaming), derive output from total_tokens.
  const directOutput = visibleOutputTokens + reasoningTokens;
  const derivedOutput =
    usage.total_tokens !== undefined
      ? Math.max(0, usage.total_tokens - inputTokens)
      : 0;

  const outputTokens = directOutput > 0 ? directOutput : derivedOutput;

  return { inputTokens, outputTokens, reasoningTokens };
}

/** Computes cost based on Interactions token usage and model pricing. */
export function computeGoogleInteractionsPrice(
  responseUsage: InteractionsUsage | null,
  config: GooglePricingConfig,
): number {
  if (!responseUsage) return 0.0;
  const { inputTokens, outputTokens } =
    computeInteractionsTokenCounts(responseUsage);

  // No reasoning surcharge: thought tokens are already part of outputTokens.
  // total_cached_tokens is a subset of total_input_tokens, so cached reads are
  // billed at the full input rate and rebated by computeStandardPrice.
  return computeStandardPrice(
    {
      inputTokens,
      outputTokens,
      cachedTokens: responseUsage.total_cached_tokens ?? 0,
    },
    config,
  );
}

/** Normalizes Google Interactions usage data into a unified format. */
export function normalizeGoogleInteractionsUsage(
  rawUsage: InteractionsUsage | null,
  responseTimeMs: number,
  config: GooglePricingConfig,
): NormalizedUsage {
  return normalizeUsage(
    {
      provider: 'google',
      computePrice: (usage) => computeGoogleInteractionsPrice(usage, config),
      extract: (usage) => {
        const { inputTokens, outputTokens, reasoningTokens } =
          computeInteractionsTokenCounts(usage);
        return {
          inputTokens,
          outputTokens,
          cachedTokens: usage.total_cached_tokens ?? 0,
          reasoningTokens,
          toolUsePromptTokens: usage.total_tool_use_tokens ?? 0,
        };
      },
    },
    rawUsage,
    responseTimeMs,
  );
}
