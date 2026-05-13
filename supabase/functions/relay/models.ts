/**
 * Relay Model Configuration
 *
 * SINGLE SOURCE OF TRUTH: llm-zoo npm package
 * Tier assignments are derived from model pricing:
 * - free: Budget models (under $1/M input)
 * - Max: Mid-tier models ($1-3/M input) + free tier
 * - Ultra: All models including premium ($3+/M input)
 */

import { MODEL_CONFIGS, type ModelConfig } from 'npm:llm-zoo@^1.6.1';
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

/** Derive tier from model pricing */
function getTierFromPrice(inputPrice: number): MinTier {
  if (inputPrice <= 3) return 'free';
  return 'Ultra';
}

/** Convert llm-zoo model to relay model */
function toRelayModel(config: ModelConfig): RelayModel {
  return {
    shortName: config.name,
    apiPatterns: [config.fullName.toLowerCase()],
    minTier: getTierFromPrice(config.inputPrice),
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
 * API keys without any limits. Current values reflect the sponsor-credit
 * promotion: free and Max tiers are bumped while the donated credits last.
 */
export const TIER_SPENDING_LIMITS: TierSpendingLimits = {
  free: 20, // $20/month - promo (bumped from $10)
  Max: 100, // $100/month - promo (bumped from $50)
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
 * Free/Max tier: all models up to $3/M input (currently identical access).
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
