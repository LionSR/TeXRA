/**
 * Google Interactions API usage accounting & pricing.
 *
 * The Interactions API reports usage with snake_case totals
 * ({@link Interactions.Usage}) that differ from the camelCase
 * `GenerateContentResponseUsageMetadata` the chat handler reads. This module
 * supplies only the snake_case field accessor; the token math, pricing, and
 * normalization are shared with the chat handler via `googleUsage.ts` — no
 * formula is duplicated.
 *
 * The handler keeps thin `computePrice` / `normalizeUsage` overrides that
 * delegate here with the model's pricing config.
 */

import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

import {
  computeGooglePriceFromFields,
  normalizeGoogleUsageFromFields,
  type GooglePricingConfig,
  type GoogleUsageFields,
} from './googleUsage';
import type { Interactions } from '@google/genai';

type InteractionsUsage = Interactions.Usage;

/**
 * Field accessors for the snake_case Interactions usage shape.
 *
 * Maps onto the same unified token model as the chat handler
 * (`outputTokens = visible output + thoughts`, input = prompt + tool-use), so
 * reasoning tokens are billed once at the output rate and never double-counted.
 *
 * NOTE: whether `total_output_tokens` already includes thoughts is documented
 * ambiguously upstream; a real-key smoke test should confirm before relying on
 * billing accuracy (spec §6.5). If the API ever folds thoughts into
 * `total_output_tokens`, drop the reasoning term in `visibleOutputTokens`'s sum
 * (see `computeGoogleTokenCounts`).
 *
 * Verified live (spec §6 S1, gemini-3.5-flash 2-round run): under
 * previous_interaction_id chaining, total_input_tokens reports the CUMULATIVE
 * server-side context, not just the new turn's delta (turn 2 reported 79 input
 * tokens for a 1-step delta send). That is correct for billing — the server
 * reprocesses the retained context — so we report it as-is; no double-count.
 */
const INTERACTIONS_USAGE_FIELDS: GoogleUsageFields<InteractionsUsage> = {
  promptTokens: (usage) => usage.total_input_tokens ?? 0,
  toolUseTokens: (usage) => usage.total_tool_use_tokens ?? 0,
  visibleOutputTokens: (usage) => usage.total_output_tokens ?? 0,
  reasoningTokens: (usage) => usage.total_thought_tokens ?? 0,
  totalTokens: (usage) => usage.total_tokens,
  cachedTokens: (usage) => usage.total_cached_tokens ?? 0,
};

/** Computes cost based on Interactions token usage and model pricing. */
export function computeGoogleInteractionsPrice(
  responseUsage: InteractionsUsage | null,
  config: GooglePricingConfig,
): number {
  return computeGooglePriceFromFields(
    responseUsage,
    config,
    INTERACTIONS_USAGE_FIELDS,
  );
}

/** Normalizes Google Interactions usage data into a unified format. */
export function normalizeGoogleInteractionsUsage(
  rawUsage: InteractionsUsage | null,
  responseTimeMs: number,
  config: GooglePricingConfig,
): NormalizedUsage {
  return normalizeGoogleUsageFromFields(
    rawUsage,
    responseTimeMs,
    config,
    INTERACTIONS_USAGE_FIELDS,
  );
}
