/**
 * Relay Model Configuration
 *
 * SINGLE SOURCE OF TRUTH for tier-based model access.
 * This file defines which models are available for each subscription tier.
 *
 * TIER HIERARCHY (cumulative access):
 * - free: Budget models only (under $1/M input)
 * - Max: Free tier models + mid-tier models ($1-3/M input)
 * - Ultra: All models including premium ($3+/M input)
 *
 * Keep synchronized with:
 * - src/model/providers/*.ts (fullName field must match apiPattern prefix)
 * - docs/relay-tier-config.md
 */

// =============================================================================
// Types
// =============================================================================

export interface TierModelsConfig {
  /** Model access: "*" for all models, or array of specific model short names */
  models: '*' | string[];
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
  shortName: string; // UI identifier (e.g., "gpt41-")
  apiPatterns: string[]; // API name prefixes for validation
  minTier: MinTier; // Minimum tier required
  /** If true, auto-generates a thinking variant (shortName + 'T') with same API patterns */
  hasThinkingVariant?: boolean;
}

// =============================================================================
// Model Definitions
// =============================================================================

/**
 * Each model entry specifies:
 * - shortName: TeXRA UI identifier (returned to client via /relay/tier-config)
 * - apiPatterns: Array of full API model name prefixes for server-side validation
 *                (supports multiple patterns for aliases like gemini-flash-latest)
 * - minTier: Minimum tier required to access this model
 * - hasThinkingVariant: If true, auto-generates thinking variant (shortName + 'T')
 *                       with same API patterns. Use for models where thinking/non-thinking
 *                       share the same API name (e.g., Claude). For models with different
 *                       API names (e.g., DeepSeek), define separate entries instead.
 *
 * IMPORTANT: When adding/removing models, update ONLY this array.
 * All derived arrays and TIER_CONFIG are auto-generated from this.
 */
const RELAY_MODELS: RelayModel[] = [
  // ===========================================================================
  // FREE TIER: Budget models (under $1/M input)
  // Available to all authenticated users without subscription.
  // ===========================================================================

  // OpenAI - Mini/Nano models
  { shortName: 'gpt5-', apiPatterns: ['gpt-5-mini'], minTier: 'free' }, // $0.25/$2.00
  { shortName: 'gpt5--', apiPatterns: ['gpt-5-nano'], minTier: 'free' }, // $0.05/$0.40
  { shortName: 'gpt41-', apiPatterns: ['gpt-4.1-mini'], minTier: 'free' }, // $0.40/$1.60
  { shortName: 'gpt41--', apiPatterns: ['gpt-4.1-nano'], minTier: 'free' }, // $0.10/$0.40

  // Google - Flash models
  { shortName: 'gemini3f', apiPatterns: ['gemini-3-flash'], minTier: 'free' }, // $0.30/$2.50

  // DeepSeek - Chat and Reasoner
  { shortName: 'deepseek', apiPatterns: ['deepseek-chat'], minTier: 'free' }, // $0.28/$0.42
  {
    shortName: 'deepseekT',
    apiPatterns: ['deepseek-reasoner'],
    minTier: 'free',
  }, // $0.28/$0.42

  // xAI - Grok Mini
  { shortName: 'grok3-', apiPatterns: ['grok-3-mini'], minTier: 'free' }, // $0.30/$0.50

  // Moonshot - Kimi models
  { shortName: 'kimi128k', apiPatterns: ['moonshot-v1-128k'], minTier: 'free' }, // $0.28/$1.12
  {
    shortName: 'kimi128kv',
    apiPatterns: ['moonshot-v1-128k-vision'],
    minTier: 'free',
  }, // $0.35/$1.40
  {
    shortName: 'kimit',
    apiPatterns: ['kimi-thinking-preview'],
    minTier: 'free',
  }, // $0.42/$1.68
  { shortName: 'kimi2', apiPatterns: ['kimi-k2-0905'], minTier: 'free' }, // $0.60/$2.50
  { shortName: 'kimi2T', apiPatterns: ['kimi-k2-thinking'], minTier: 'free' }, // $0.56/$2.22

  // ===========================================================================
  // MAX TIER: Mid-tier models ($1-3/M input)
  // Requires Max subscription, includes all free tier models
  // ===========================================================================

  // Anthropic - Haiku 4.5 and Sonnet 4.5 (hasThinkingVariant auto-generates T variants)
  { shortName: 'haiku45', apiPatterns: ['claude-haiku-4-5'], minTier: 'Max', hasThinkingVariant: true }, // $1.00/$5.00
  { shortName: 'sonnet45', apiPatterns: ['claude-sonnet-4-5'], minTier: 'Max', hasThinkingVariant: true }, // $3.00/$15.00

  // Google - Gemini Pro models
  { shortName: 'gemini3p', apiPatterns: ['gemini-3-pro'], minTier: 'Max' }, // $2.00/$12.00
  { shortName: 'gemini25p', apiPatterns: ['gemini-2.5-pro'], minTier: 'Max' }, // $1.25/$10.00

  // xAI - Grok 2 models
  { shortName: 'grok2', apiPatterns: ['grok-2-1212'], minTier: 'Max' }, // $2.00/$10.00
  { shortName: 'grok2v', apiPatterns: ['grok-2-1212-vision'], minTier: 'Max' }, // $2.00/$10.00

  // Moonshot - Kimi Turbo models
  { shortName: 'kimi2+', apiPatterns: ['kimi-k2-turbo'], minTier: 'Max' }, // $2.24/$8.88
  {
    shortName: 'kimi2T+',
    apiPatterns: ['kimi-k2-thinking-turbo'],
    minTier: 'Max',
  }, // $2.24/$8.88

  // ===========================================================================
  // ULTRA TIER: Premium models ($3+/M input)
  // Requires Ultra subscription (models: '*' grants all access)
  // Examples: Opus, GPT-5 series, DeepSeek R1, Grok 3/4
  // These are NOT listed here since Ultra uses models: '*'
  // ===========================================================================
];

// =============================================================================
// Derived Arrays (auto-generated from RELAY_MODELS)
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

/**
 * Expand short names to include thinking variants.
 * Models with hasThinkingVariant get both base and T suffix versions.
 */
function expandShortNames(models: RelayModel[]): string[] {
  return models.flatMap((m) =>
    m.hasThinkingVariant ? [m.shortName, `${m.shortName}T`] : [m.shortName],
  );
}

const FREE_TIER_MODELS = getModelsForTier('free');
const MAX_TIER_MODELS = getModelsForTier('Max');

const FREE_TIER_SHORT_NAMES = expandShortNames(FREE_TIER_MODELS);
const MAX_TIER_SHORT_NAMES = expandShortNames(MAX_TIER_MODELS);

const FREE_TIER_API_PATTERNS = FREE_TIER_MODELS.flatMap((m) =>
  m.apiPatterns.map((p) => p.toLowerCase()),
);
const MAX_TIER_API_PATTERNS = MAX_TIER_MODELS.flatMap((m) =>
  m.apiPatterns.map((p) => p.toLowerCase()),
);

// All supported providers (same for all tiers)
const ALL_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'moonshot',
  'dashscope',
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

// =============================================================================
// Validation Functions
// =============================================================================

// Tier constants (must match src/auth/config.ts)
const ULTRA_TIER = 'Ultra';
const MAX_TIER = 'Max';
const FREE_TIER = 'free';

/**
 * Check if a model is allowed for a given tier.
 *
 * Uses PREFIX pattern matching to handle version suffixes in model names.
 * E.g., "gpt-4.1-mini-2025-04-14" matches pattern "gpt-4.1-mini"
 *
 * @param tier - User's tier (Ultra, Max, or free)
 * @param modelName - The API model name to check
 * @returns true if the model is allowed for the tier
 */
export function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) {
    return true; // Ultra gets all models
  }

  if (!modelName) return false;

  const normalizedModel = modelName.toLowerCase();

  if (tier === MAX_TIER) {
    return MAX_TIER_API_PATTERNS.some((pattern) =>
      normalizedModel.startsWith(pattern),
    );
  }

  if (tier === FREE_TIER) {
    return FREE_TIER_API_PATTERNS.some((pattern) =>
      normalizedModel.startsWith(pattern),
    );
  }

  return false;
}
