/**
 * Relay Model Configuration
 *
 * SINGLE SOURCE OF TRUTH: llm-zoo npm package
 * Tier assignments are derived from model pricing. A model is "free" only when
 * BOTH its input AND output prices are cheap, so a cheap-input / expensive-output
 * flagship (gemini-3.x-pro at $2/$12, gpt-5 at $1.25/$10) can no longer leak into
 * free on input price alone. See MAX_FREE_INPUT_PRICE / MAX_FREE_OUTPUT_PRICE.
 * - free: input <= $1.5/M AND output <= $9/M, excluding ULTRA_ONLY_PROVIDERS
 * - Max: every model except ULTRA_ONLY_PROVIDERS (not bounded by the
 *   free-tier price ceiling)
 * - Ultra: every model
 *
 * openai/anthropic/google were made Ultra-only via relay on 2026-07-14 (relay
 * still proxies them for Ultra; free/Max users can still reach them with
 * their own API keys, just not through relay's server-side keys).
 */

import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';
import { normalizeModelName, stripProviderPrefix } from './modelNames.ts';

/** Tier value constants shared by relay modules. */
export const ULTRA_TIER = 'Ultra';
export const MAX_TIER = 'Max';
export const FREE_TIER = 'free';

// =============================================================================
// Types
// =============================================================================

/** The relay tier ladder. Every per-tier table below is keyed by this union. */
type Tier = typeof FREE_TIER | typeof MAX_TIER | typeof ULTRA_TIER;

interface TierModelsConfig {
  /** Model access: "*" for all models, or array of specific model short names */
  models: '*' | string[];
}

/** Per-user request gates enforced by the relay edge function. */
interface TierRequestLimit {
  /** Per clock-minute request count. */
  ratePerMinute: number;
  /** In-flight upstream requests for this user. */
  concurrent: number;
}

export interface TierModelConfig {
  /** All supported providers (same for all tiers) */
  providers: string[];
  /** Per-tier model access */
  tiers: Partial<Record<Tier, TierModelsConfig>>;
}

type AuthType = 'bearer' | 'x-api-key' | 'x-goog-api-key';

interface ProviderConfig {
  baseUrl: string;
  envKey: string;
  authType: AuthType;
}

/** Provider routing metadata shared by relay discovery and forwarding. */
export const PROVIDER_CONFIGS = Object.freeze({
  openai: Object.freeze({
    baseUrl: 'https://api.openai.com',
    envKey: 'OPENAI_API_KEY',
    authType: 'bearer',
  }),
  anthropic: Object.freeze({
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    authType: 'x-api-key',
  }),
  google: Object.freeze({
    baseUrl: 'https://generativelanguage.googleapis.com',
    envKey: 'GOOGLE_API_KEY',
    authType: 'x-goog-api-key',
  }),
  xai: Object.freeze({
    baseUrl: 'https://api.x.ai',
    envKey: 'XAI_API_KEY',
    authType: 'bearer',
  }),
  deepseek: Object.freeze({
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    authType: 'bearer',
  }),
  moonshot: Object.freeze({
    baseUrl: 'https://api.moonshot.cn',
    envKey: 'MOONSHOT_API_KEY',
    authType: 'bearer',
  }),
  dashscope: Object.freeze({
    baseUrl: 'https://dashscope-intl.aliyuncs.com',
    envKey: 'DASHSCOPE_API_KEY',
    authType: 'bearer',
  }),
  minimax: Object.freeze({
    baseUrl: 'https://api.minimax.io',
    envKey: 'MINIMAX_API_KEY',
    authType: 'bearer',
  }),
  glm: Object.freeze({
    baseUrl: 'https://api.z.ai',
    envKey: 'GLM_API_KEY',
    authType: 'bearer',
  }),
} as const satisfies Record<string, ProviderConfig>);

interface RelayModel {
  shortName: string;
  apiPattern: string;
  minTier: Tier;
  provider: string;
}

/**
 * Providers only reachable via relay on the Ultra tier. free/Max users can
 * still use these providers with their own API keys; they're just not
 * proxied through relay's server-side keys below Ultra.
 */
export const ULTRA_ONLY_PROVIDERS = ['openai', 'anthropic', 'google'] as const;
export const ULTRA_ONLY_PROVIDER_SET = new Set<string>(ULTRA_ONLY_PROVIDERS);

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
function getTierFromPrice(inputPrice: number, outputPrice: number): Tier {
  if (
    inputPrice <= MAX_FREE_INPUT_PRICE &&
    outputPrice <= MAX_FREE_OUTPUT_PRICE
  ) {
    return 'free';
  }
  return 'Ultra';
}

/**
 * TeXRA model selector id for the free-tier model an over-tier user is pointed
 * at in a 403, so the denial suggests something they can type instead of only
 * an upsell. Kept next to the price ceiling it must satisfy (input <= 1.5,
 * output <= 9).
 */
export const FREE_TIER_SUGGESTED_MODEL = 'deepseek';

/** Convert llm-zoo model to relay model */
function toRelayModel(config: ModelConfig): RelayModel {
  return {
    shortName: config.name,
    apiPattern: config.fullName.toLowerCase(),
    minTier: getTierFromPrice(config.inputPrice, config.outputPrice),
    provider: config.provider,
  };
}

// =============================================================================
// Model Definitions (derived from llm-zoo)
// =============================================================================

// All providers the relay can actually forward to.
const RELAY_PROVIDERS = new Set<string>(Object.keys(PROVIDER_CONFIGS));

// Kimi Code membership models are pinned to Moonshot's coding endpoint and can
// only be served with a per-user Kimi Code key, so the relay (which forwards
// with its own Moonshot open-platform key) must never advertise them. The pin
// distinguishes them from `kimi3`, which stays relay-eligible via `kimi-k3`.
const KIMI_CODE_CODING_BASE_URL = 'https://api.kimi.com/coding/v1';

/** All relay-compatible models from llm-zoo, converted to relay format. */
const RELAY_MODELS: RelayModel[] = Object.values(MODEL_CONFIGS)
  .filter(
    (m) =>
      RELAY_PROVIDERS.has(m.provider) &&
      !m.openRouterOnly &&
      !m.retired &&
      m.baseUrl !== KIMI_CODE_CODING_BASE_URL,
  )
  .map(toRelayModel);

// Retired-name detection is a denial guard, not an allowlist. Keep every
// direct-provider retirement so a future unsupported provider cannot bypass
// the retired-model rejection before normal provider routing.
const RETIRED_MODEL_PATTERNS = Object.values(MODEL_CONFIGS)
  .filter((m) => !m.openRouterOnly && m.retired)
  .flatMap((m) =>
    [m.name, m.fullName, m.openrouterFullName]
      .filter((name): name is string => name != null)
      .map((name) => name.toLowerCase()),
  );

// =============================================================================
// Derived Arrays
// =============================================================================

// Max is every relay model outside the Ultra-only providers; free is the
// subset of those that also sit under the free price ceiling.
const MAX_TIER_MODELS = RELAY_MODELS.filter(
  (m) => !ULTRA_ONLY_PROVIDER_SET.has(m.provider.toLowerCase()),
);

const MAX_TIER_SHORT_NAMES = MAX_TIER_MODELS.map((m) => m.shortName);

const FREE_TIER_SHORT_NAMES = MAX_TIER_MODELS.filter(
  (m) => m.minTier === FREE_TIER,
).map((m) => m.shortName);

// =============================================================================
// Tier Configuration (exported for /tier-config endpoint)
// =============================================================================

export const TIER_CONFIG: TierModelConfig = {
  providers: [...RELAY_PROVIDERS],
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
export const TIER_SPENDING_LIMITS: Record<Tier, number> = {
  free: 10, // $10/month
  Max: 50, // $50/month
  Ultra: 300, // $300/month - sponsor access
};

/**
 * Server-side fairness gates. These are deliberately loose enough for normal
 * interactive use while blocking bulk free-tier fanout before costs are logged.
 */
const TIER_REQUEST_LIMITS: Record<Tier, TierRequestLimit> = {
  free: { ratePerMinute: 20, concurrent: 4 },
  Max: { ratePerMinute: 60, concurrent: 8 },
  Ultra: { ratePerMinute: 120, concurrent: 16 },
};

// =============================================================================
// Tier Constants
// =============================================================================

/**
 * Get the monthly spending limit for a tier.
 */
export function getSpendingLimit(tier: string): number {
  return TIER_SPENDING_LIMITS[tier as Tier] ?? TIER_SPENDING_LIMITS.free;
}

/** Get per-user request gates for a tier. */
export function getRequestLimits(tier: string): TierRequestLimit {
  return TIER_REQUEST_LIMITS[tier as Tier] ?? TIER_REQUEST_LIMITS.free;
}

// =============================================================================
// Validation Functions
// =============================================================================

/** Word-boundary separators that may follow a model-name prefix in API names. */
const BOUNDARY_RE = /^[-/:@.]/;

/**
 * Collect all RelayModel entries whose apiPattern matches the given API model
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
  const name = normalizeModelName(modelName);
  const modelPart = stripProviderPrefix(name);

  const exactMatches: RelayModel[] = [];
  let bestBoundaryLen = -1;
  const boundaryMatches: RelayModel[] = [];

  for (const model of RELAY_MODELS) {
    const pattern = model.apiPattern;
    if (modelPart === pattern || name === pattern) {
      exactMatches.push(model);
      continue;
    }

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
    }
  }

  return exactMatches.length > 0 ? exactMatches : boundaryMatches;
}

/** Return a registry-owned model identifier suitable for diagnostics.
 * Unknown and caller-defined model text must not enter logs. */
export function getCanonicalRelayModelName(
  modelName: string | null,
): string | null {
  if (!modelName) return null;
  return resolveAllModelsByApiName(modelName).at(0)?.apiPattern ?? null;
}

export function isRetiredModelRequest(modelName: string): boolean {
  const name = normalizeModelName(modelName);
  const modelPart = stripProviderPrefix(name);
  return RETIRED_MODEL_PATTERNS.some(
    (pattern) => modelPart === pattern || name === pattern,
  );
}

/**
 * Check if a model is allowed for a given tier.
 * Free tier: models within the free price ceiling (input <= $1.5/M AND
 * output <= $9/M).
 * Max tier: any explicit model name.
 * Ultra tier: all model names and model-less provider endpoints.
 *
 * When multiple llm-zoo entries share the same API model name, a `some()`
 * check is used: access is granted if at least one interpretation falls
 * within the user's tier. Unknown model names are denied for the free tier and
 * allowed for Max, where the relay only needs to distinguish explicit model
 * requests from model-less provider endpoints.
 */
export function isModelAllowedForTier(
  tier: string,
  modelName: string | null,
): boolean {
  if (tier === ULTRA_TIER) {
    return modelName == null || !isRetiredModelRequest(modelName);
  }
  if (!modelName) return false;
  if (isRetiredModelRequest(modelName)) return false;
  // Ultra-only-provider enforcement lives at the route level (the URL
  // provider segment, checked against ULTRA_ONLY_PROVIDER_SET before this
  // function runs), not here by model name — this stays a blanket allow for
  // Max.
  if (tier === MAX_TIER) return true;

  const models = resolveAllModelsByApiName(modelName);
  if (models.length === 0) return false;

  return models.some((m) => m.minTier === FREE_TIER);
}
