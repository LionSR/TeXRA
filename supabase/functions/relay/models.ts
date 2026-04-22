/**
 * Relay Model Configuration
 *
 * SINGLE SOURCE OF TRUTH: llm-zoo npm package
 * Tier assignments are derived from model pricing:
 * - free: Budget models (under $1/M input)
 * - Max: Mid-tier models ($1-3/M input) + free tier
 * - Ultra: All models including premium ($3+/M input)
 */

import { MODEL_CONFIGS, type ModelConfig } from 'npm:llm-zoo@^1.4.0';

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
  };
}

// =============================================================================
// Model Definitions (derived from llm-zoo)
// =============================================================================

/** All models from llm-zoo, converted to relay format */
const RELAY_MODELS: RelayModel[] = Object.values(MODEL_CONFIGS)
  .filter((m) => !m.openRouterOnly) // Exclude OpenRouter-only models
  .map(toRelayModel);

/**
 * Ultra-only models: reserved for Ultra-tier users even during the
 * sponsor-credit promotion. Matches gpt-5-pro, gpt-5.2-pro, gpt-5.4-pro, etc.
 * Accepts optional provider prefixes like "openai/gpt-5.4-pro".
 */
const ULTRA_ONLY_PATTERN =
  /^(?:[a-z0-9_-]+\/)?gpt-5(?:\.\d+)?-pro(?:$|[-:@/])/i;

function isUltraOnlyModelName(modelName: string): boolean {
  return ULTRA_ONLY_PATTERN.test(modelName.trim());
}

const isUltraOnlyModel = (model: RelayModel): boolean =>
  model.apiPatterns.some(isUltraOnlyModelName);

const NON_ULTRA_ONLY_SHORT_NAMES = RELAY_MODELS.filter(
  (m) => !isUltraOnlyModel(m),
).map((m) => m.shortName);

// =============================================================================
// Derived Arrays
// =============================================================================

/** Get models available for a specific tier (cumulative access) */
function getModelsForTier(tier: MinTier): RelayModel[] {
  if (tier === 'Ultra') return RELAY_MODELS;
  if (tier === 'Max')
    return RELAY_MODELS.filter(
      (m) => m.minTier === 'free' || m.minTier === 'Max',
    );
  return RELAY_MODELS.filter((m) => m.minTier === 'free');
}

const FREE_TIER_MODELS = getModelsForTier('free');
const MAX_TIER_MODELS = getModelsForTier('Max');

const FREE_TIER_SHORT_NAMES = FREE_TIER_MODELS.map((m) => m.shortName);
const MAX_TIER_SHORT_NAMES = MAX_TIER_MODELS.map((m) => m.shortName);

const FREE_TIER_API_PATTERNS = FREE_TIER_MODELS.flatMap((m) => m.apiPatterns);
const MAX_TIER_API_PATTERNS = MAX_TIER_MODELS.flatMap((m) => m.apiPatterns);

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
    free: { models: NON_ULTRA_ONLY_SHORT_NAMES },
    Max: { models: NON_ULTRA_ONLY_SHORT_NAMES },
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

/**
 * Check if a model is allowed for a given tier.
 * During the sponsor-credit promotion, all models are open to every tier
 * EXCEPT the gpt-5 "pro" variants, which remain reserved for Ultra users.
 */
export function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) return true;
  if (!modelName) return false;
  return !isUltraOnlyModelName(modelName);
}

// =============================================================================
// Debug/Info Exports
// =============================================================================

/** Get pricing breakdown by tier (useful for debugging) */
export function getTierBreakdown(): Record<
  MinTier,
  { count: number; models: string[] }
> {
  return {
    free: {
      count: FREE_TIER_MODELS.length,
      models: FREE_TIER_MODELS.map((m) => `${m.shortName} ($${m.inputPrice})`),
    },
    Max: {
      count: MAX_TIER_MODELS.length - FREE_TIER_MODELS.length,
      models: MAX_TIER_MODELS.filter((m) => m.minTier === 'Max').map(
        (m) => `${m.shortName} ($${m.inputPrice})`,
      ),
    },
    Ultra: {
      count: RELAY_MODELS.length - MAX_TIER_MODELS.length,
      models: RELAY_MODELS.filter((m) => m.minTier === 'Ultra').map(
        (m) => `${m.shortName} ($${m.inputPrice})`,
      ),
    },
  };
}
