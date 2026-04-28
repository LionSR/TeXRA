/**
 * Relay Model Configuration
 *
 * SINGLE SOURCE OF TRUTH: llm-zoo npm package
 * Tier assignments are derived from model pricing and capabilities:
 * - free: Budget non-thinking models (under $1/M input, supportsReasoning=false)
 * - Max: All models up to $3/M input, including thinking variants
 * - Ultra: All models including premium ($3+/M input)
 */

import { MODEL_CONFIGS, type ModelConfig } from 'npm:llm-zoo@^1.6.0';

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
  supportsReasoning: boolean;
}

// =============================================================================
// Tier Assignment Logic
// =============================================================================

/** Derive tier from model pricing */
function getTierFromPrice(inputPrice: number): MinTier {
  if (inputPrice < 1) return 'free';
  if (inputPrice <= 3) return 'Max';
  return 'Ultra';
}

/** Convert llm-zoo model to relay model */
function toRelayModel(config: ModelConfig): RelayModel {
  return {
    shortName: config.name,
    apiPatterns: [config.fullName.toLowerCase()],
    minTier: getTierFromPrice(config.inputPrice),
    inputPrice: config.inputPrice,
    supportsReasoning: config.capabilities?.supportsReasoning ?? false,
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

/**
 * Free tier: budget models (under $1/M input) excluding thinking/reasoning
 * variants — those are more capable and consume significantly more tokens.
 * Max tier: all models up to $3/M input (including thinking variants).
 */
const FREE_TIER_MODELS = RELAY_MODELS.filter(
  (m) => m.minTier === 'free' && !m.supportsReasoning,
);
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
  Ultra: 1500, // $1500/month - sponsor access
};

// =============================================================================
// Tier Constants
// =============================================================================

/** Tier value constants - exported for use in relay index.ts */
export const ULTRA_TIER = 'Ultra';
export const MAX_TIER = 'Max';
export const FREE_TIER = 'free';

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

/** Tier rank for restrictiveness comparison (higher = more restricted). */
const TIER_RANK: Record<MinTier, number> = { free: 0, Max: 1, Ultra: 2 };

/**
 * Compare two relay models and return true if `a` is more restrictive than `b`.
 * Higher tier wins; within same tier, thinking variants (supportsReasoning) win.
 * Used to break ties when multiple entries share the same API model name.
 */
function isMoreRestrictive(a: RelayModel, b: RelayModel): boolean {
  const tierDiff = TIER_RANK[a.minTier] - TIER_RANK[b.minTier];
  if (tierDiff !== 0) return tierDiff > 0;
  return a.supportsReasoning && !b.supportsReasoning;
}

/**
 * Resolve an API model name to the best-matching RelayModel using
 * boundary-aware longest-prefix matching. Returns undefined when the name
 * does not correspond to any known model.
 *
 * Strips an optional "provider/" prefix before matching so that both
 * "openai/gpt-4o-mini" and "gpt-4o-mini" resolve to the same entry.
 *
 * Longest match wins (most specific pattern), preventing a short free-tier
 * pattern like "glm-5" from matching a paid "glm-5-turbo" entry.
 *
 * When multiple entries share the same API name (e.g. a thinking and a
 * non-thinking variant of the same model), the most restrictive entry wins
 * so tier gating is never bypassed by iteration order.
 */
function resolveModelByApiName(modelName: string): RelayModel | undefined {
  const name = modelName.toLowerCase().trim();
  const modelPart = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;

  let bestExact: RelayModel | undefined;
  let bestBoundary: RelayModel | undefined;
  let bestBoundaryLen = -1;

  for (const model of RELAY_MODELS) {
    for (const pattern of model.apiPatterns) {
      if (modelPart === pattern || name === pattern) {
        // Exact match: keep the most restrictive among all exact matches
        if (!bestExact || isMoreRestrictive(model, bestExact)) bestExact = model;
        break; // Only check each model once
      }

      // Boundary-aware prefix: next character must be a separator
      const isBoundary =
        (modelPart.startsWith(pattern) && BOUNDARY_RE.test(modelPart.slice(pattern.length))) ||
        (name.startsWith(pattern) && BOUNDARY_RE.test(name.slice(pattern.length)));

      if (isBoundary && pattern.length > bestBoundaryLen) {
        bestBoundary = model;
        bestBoundaryLen = pattern.length;
      }
    }
  }

  // Exact matches always take precedence over boundary (prefix) matches
  return bestExact ?? bestBoundary;
}

/**
 * Check if a model is allowed for a given tier.
 * Free tier: budget non-thinking models only (under $1/M input, no reasoning).
 * Max tier: all models up to $3/M input (includes thinking variants).
 * Ultra tier: all models.
 *
 * Unknown model names are denied for non-Ultra tiers.
 */
export function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) return true;
  if (!modelName) return false;

  const model = resolveModelByApiName(modelName);
  if (!model) return false;

  if (tier === MAX_TIER) return model.minTier === 'free' || model.minTier === 'Max';
  // free tier: only non-thinking budget models
  return model.minTier === 'free' && !model.supportsReasoning;
}

// =============================================================================
// Debug/Info Exports
// =============================================================================

/** Get pricing breakdown by tier (useful for debugging) */
export function getTierBreakdown(): Record<
  MinTier,
  { count: number; models: string[] }
> {
  const freeNames = new Set(FREE_TIER_SHORT_NAMES);
  const maxNames = new Set(MAX_TIER_SHORT_NAMES);
  const maxOnly = MAX_TIER_MODELS.filter((m) => !freeNames.has(m.shortName));
  const ultraOnly = RELAY_MODELS.filter((m) => !maxNames.has(m.shortName));
  return {
    free: {
      count: FREE_TIER_MODELS.length,
      models: FREE_TIER_MODELS.map((m) => `${m.shortName} ($${m.inputPrice})`),
    },
    Max: {
      count: maxOnly.length,
      models: maxOnly.map((m) => `${m.shortName} ($${m.inputPrice})`),
    },
    Ultra: {
      count: ultraOnly.length,
      models: ultraOnly.map((m) => `${m.shortName} ($${m.inputPrice})`),
    },
  };
}
