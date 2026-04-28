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

/**
 * Check if a model is allowed for a given tier.
 * Free tier: budget non-thinking models only (under $1/M input, no reasoning).
 * Max tier: all models up to $3/M input (includes thinking variants).
 * Ultra tier: all models.
 *
 * Strips optional provider prefix (e.g. "openai/gpt-4o-mini") before matching.
 */
export function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) return true;
  if (!modelName) return false;

  const name = modelName.toLowerCase().trim();
  // Strip optional "provider/" prefix used in some generic endpoints
  const modelPart = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;

  const patterns = tier === MAX_TIER ? MAX_TIER_API_PATTERNS : FREE_TIER_API_PATTERNS;
  return patterns.some((p) => modelPart.startsWith(p) || name.startsWith(p));
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
