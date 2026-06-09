/**
 * Relay Model Configuration
 *
 * SINGLE SOURCE OF TRUTH: llm-zoo npm package
 * Tier assignments are derived from model pricing. A model is "free" only when
 * BOTH its input AND output prices are cheap, so a cheap-input / expensive-output
 * flagship (gemini-3.x-pro at $2/$12, gpt-5 at $1.25/$10) can no longer leak into
 * free on input price alone. See MAX_FREE_INPUT_PRICE / MAX_FREE_OUTPUT_PRICE.
 * - free: input <= $1.5/M AND output <= $9/M
 * - Max: free-tier models plus any future Max-only additions
 * - Ultra: everything else
 */

import { MODEL_CONFIGS, type ModelConfig } from 'npm:llm-zoo@^1.8.1';
import { FREE_TIER, MAX_TIER, ULTRA_TIER } from './tierConstants.ts';

export { FREE_TIER, MAX_TIER, ULTRA_TIER };

// =============================================================================
// Types
// =============================================================================

export interface TierModelsConfig {
  /** Model access: "*" for all models, or array of specific model short names */
  models: '*' | string[];
}

/** Monthly spending limits by tier (in USD) */
export interface TierSpendingLimits {
  free: number;
  Max: number;
  Ultra: number;
}

export interface TierModelConfig {
  /** All supported providers (same for all tiers) */
  providers: string[];
  /** Per-tier model access */
  tiers: {
    free?: TierModelsConfig;
    Max?: TierModelsConfig;
    Ultra?: TierModelsConfig;
  };
}

export type MinTier = 'free' | 'Max' | 'Ultra';

interface RelayModel {
  shortName: string;
  apiPatterns: string[];
  minTier: MinTier;
  inputPrice: number;
}

// =============================================================================
// Tier Assignment Logic
// =============================================================================

/**
 * Free-tier price ceiling. A model is included for free only when BOTH bounds
 * hold, so a cheap-input / expensive-output flagship (the gemini-3.x-pro /
 * gpt-5 abuse class) cannot ride in on input price alone. Output is the
 * dominant cost in generation-heavy agent loops, hence the explicit output gate.
 * gemini-3.5-flash ($1.5 in / $9 out) sits at the ceiling by design.
 */
const MAX_FREE_INPUT_PRICE = 1.5;
const MAX_FREE_OUTPUT_PRICE = 9;

/** Derive tier from model pricing (input AND output bounded for free). */
function getTierFromPrice(inputPrice: number, outputPrice: number): MinTier {
  if (
    inputPrice <= MAX_FREE_INPUT_PRICE &&
    outputPrice <= MAX_FREE_OUTPUT_PRICE
  ) {
    return 'free';
  }
  return 'Ultra';
}

/**
 * Human-facing model name an over-tier free user is pointed at in a 403, so the
 * denial suggests something usable instead of only an upsell. Kept next to the
 * price ceiling it must satisfy (input <= 1.5, output <= 9).
 */
export const FREE_TIER_SUGGESTED_MODEL = 'gemini-3.5-flash';

/** Convert llm-zoo model to relay model */
function toRelayModel(config: ModelConfig): RelayModel {
  return {
    shortName: config.name,
    apiPatterns: [config.fullName.toLowerCase()],
    minTier: getTierFromPrice(config.inputPrice, config.outputPrice),
    inputPrice: config.inputPrice,
  };
}

// =============================================================================
// Model Definitions (derived from llm-zoo)
// =============================================================================

/** All relay-compatible models from llm-zoo, converted to relay format. */
const RELAY_MODELS: RelayModel[] = Object.values(MODEL_CONFIGS)
  .filter((m) => !m.openRouterOnly)
  .map(toRelayModel);

// =============================================================================
// Derived Arrays
// =============================================================================

const FREE_TIER_MODELS = RELAY_MODELS.filter((m) => m.minTier === 'free');
const MAX_TIER_MODELS = RELAY_MODELS.filter(
  (m) => m.minTier === 'free' || m.minTier === 'Max',
);

const FREE_TIER_SHORT_NAMES = FREE_TIER_MODELS.map((m) => m.shortName);
const MAX_TIER_SHORT_NAMES = MAX_TIER_MODELS.map((m) => m.shortName);

// All supported providers
const ALL_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'moonshot',
  'dashscope',
  'minimax',
  'glm',
] as const;

// =============================================================================
// Tier Configuration (exported for /tier-config endpoint)
// =============================================================================

export const TIER_CONFIG: TierModelConfig = {
  providers: [...ALL_PROVIDERS],
  tiers: {
    free: { models: FREE_TIER_SHORT_NAMES },
    Max: { models: MAX_TIER_SHORT_NAMES },
    Ultra: { models: '*' },
  },
};

/**
 * Monthly spending limits by tier (in USD).
 *
 * These limits apply to relay usage only. Users can always use their own
 * API keys without any limits.
 */
export const TIER_SPENDING_LIMITS: TierSpendingLimits = {
  free: 10, // $10/month
  Max: 50, // $50/month
  Ultra: 300, // $300/month - sponsor access
};

// =============================================================================
// Tier Constants
// =============================================================================

/**
 * Get the monthly spending limit for a tier.
 */
export function getSpendingLimit(tier: string): number {
  return (
    TIER_SPENDING_LIMITS[tier as keyof TierSpendingLimits] ??
    TIER_SPENDING_LIMITS.free
  );
}

// =============================================================================
// Validation Functions
// =============================================================================

/** Word-boundary separators that may follow a model-name prefix in API names. */
const BOUNDARY_RE = /^[-/:@.]/;

/**
 * Collect all RelayModel entries whose apiPatterns match the given API model
 * name. Exact matches take precedence over boundary-prefix matches.
 *
 * Strips an optional "provider/" prefix so "openai/gpt-4o-mini" and
 * "gpt-4o-mini" resolve identically.
 *
 * For boundary matches, only the longest-matching pattern length is kept
 * (prevents a short free-tier "glm-5" from co-matching with "glm-5-turbo").
 *
 * Returns all matching entries rather than a single winner because the same
 * API model name can map to multiple llm-zoo entries (e.g. multiple pricing
 * tiers for the same model). The caller decides how to interpret the set.
 */
function resolveAllModelsByApiName(modelName: string): RelayModel[] {
  const name = modelName.toLowerCase().trim();
  const modelPart = name.includes('/')
    ? name.slice(name.indexOf('/') + 1)
    : name;

  const exactMatches: RelayModel[] = [];
  let bestBoundaryLen = -1;
  const boundaryMatches: RelayModel[] = [];

  for (const model of RELAY_MODELS) {
    let isExact = false;
    for (const pattern of model.apiPatterns) {
      if (modelPart === pattern || name === pattern) {
        isExact = true;
        break;
      }
    }
    if (isExact) {
      exactMatches.push(model);
      continue;
    }

    for (const pattern of model.apiPatterns) {
      const isBoundary =
        (modelPart.startsWith(pattern) &&
          BOUNDARY_RE.test(modelPart.slice(pattern.length))) ||
        (name.startsWith(pattern) &&
          BOUNDARY_RE.test(name.slice(pattern.length)));
      if (isBoundary) {
        if (pattern.length > bestBoundaryLen) {
          boundaryMatches.length = 0;
          bestBoundaryLen = pattern.length;
        }
        if (pattern.length === bestBoundaryLen) boundaryMatches.push(model);
        break;
      }
    }
  }

  return exactMatches.length > 0 ? exactMatches : boundaryMatches;
}

/**
 * Check if a model is allowed for a given tier.
 * Free/Max tier: models within the free price ceiling (input <= $1.5/M AND
 * output <= $9/M); Max currently has identical access.
 * Ultra tier: all models.
 *
 * When multiple llm-zoo entries share the same API model name, a `some()`
 * check is used: access is granted if at least one interpretation falls
 * within the user's tier. Unknown model names are denied for non-Ultra tiers.
 */
export function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) return true;
  if (!modelName) return false;

  const models = resolveAllModelsByApiName(modelName);
  if (models.length === 0) return false;

  if (tier === MAX_TIER) {
    return models.some(
      (m) => m.minTier === FREE_TIER || m.minTier === MAX_TIER,
    );
  }
  return models.some((m) => m.minTier === FREE_TIER);
}
