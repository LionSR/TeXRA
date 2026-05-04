// Third-party imports
import { MODEL_CONFIGS, hint, type ModelConfig } from 'llm-zoo';

// Local imports - platform
import { platform } from '@platform/platform';

// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - state
import { GlobalStateKey } from '@common/state/stateKeys';

// Local imports - shared schemas
import type { ModelOptionData } from '@shared/schemas';

// Local imports - shared constants
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import {
  FAST_FIRST_RESPONSE_HINT,
  isFastFirstResponseModel,
} from '@shared/constants/fastModels';
import {
  EXPENSIVE_MODEL_HINT,
  isExpensiveModel,
} from '@shared/constants/expensiveModels';

// Local imports - sibling
import { API_PROVIDERS, apiKeyExists, type ApiProvider } from './apiProviders';

/** Return whether the registry marks a model as deprecated. */
export function isDeprecatedModel(model: string): boolean {
  return MODEL_CONFIGS[model]?.deprecated ?? false;
}

/**
 * Default models that should be present in every user's model list.
 * Update this list and increment MODEL_LIST_VERSION below when adding or
 * removing models.
 */
export const DEFAULT_MODELS = [
  'gemini31p',
  'sonnet46T',
  'opus47T',
  'gpt55',
  'gpt54',
  'deepseekT',
  'deepseekproT',
  'kimi26T',
];

/**
 * Version gate for model-list migrations.
 * Increment this when adding/removing defaults or when existing users need
 * their persisted enabled-model list reconciled with current model metadata.
 * A simple integer avoids hash-collision risks and doesn't trigger on
 * harmless reordering.
 */
export const MODEL_LIST_VERSION = 15;

/**
 * Get the list of visible models from extension global state.
 * This should be used to validate model selections in proposals.
 */
export function getVisibleModels(): string[] {
  return platform().globalState.get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    DEFAULT_MODELS,
  );
}

/**
 * Resolve a model to a valid visible model.
 * Returns the model as-is if visible, falls back to the first visible model,
 * or allows any model when none are configured (consistent with agent filterVisible).
 */
export function resolveVisibleModel(model: string): string {
  const visibleModels = getVisibleModels();
  if (visibleModels.length === 0) return model;
  if (visibleModels.includes(model)) return model;
  return visibleModels[0];
}

/** Context window formatting thresholds */
const MILLION = 1_000_000;
const THOUSAND = 1_000;

/** Format context window number for display. */
export function formatContext(context: number | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context >= MILLION) return `${(context / MILLION).toFixed(1)}M`;
  if (context >= THOUSAND) return `${Math.round(context / THOUSAND)}K`;
  return context.toString();
}

/** Format cost values for display. */
export function formatCost(
  inputPrice: number | undefined,
  outputPrice: number | undefined,
): string | undefined {
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  return `$${inputPrice.toFixed(3)}/$${outputPrice.toFixed(3)}`;
}

const prefixHint = (prefix: string, base: string): string =>
  base ? `${prefix} | ${base}` : prefix;

/**
 * Build the model tooltip string, prepending an attention-grabbing nudge
 * for unusually cheap fast options or unusually expensive Pro variants.
 * Expensive takes precedence — no current model is both.
 */
function buildModelHint(config: ModelConfig): string {
  const base = hint(config);
  if (isExpensiveModel(config.provider, config.name))
    return prefixHint(EXPENSIVE_MODEL_HINT, base);
  if (isFastFirstResponseModel(config.inputPrice))
    return prefixHint(FAST_FIRST_RESPONSE_HINT, base);
  return base;
}

/** Check if a model is available via personal API keys. */
async function hasPersonalKeyForModel(
  config: ModelConfig,
  hasOpenRouter: boolean,
): Promise<boolean> {
  if (config.openRouterOnly) return hasOpenRouter;

  const provider = config.provider as ApiProvider;
  if (!(API_PROVIDERS as readonly string[]).includes(provider)) return true;

  try {
    return (
      (await apiKeyExists(platform().secrets, provider)) ||
      !!(config.openrouterFullName && hasOpenRouter)
    );
  } catch {
    return false;
  }
}

interface ModelAvailabilityContext {
  hasOpenRouter: boolean;
  hasServerAccess: boolean;
  useIncludedAccess: boolean;
  serverSideKeyService: ReturnType<typeof getServerSideKeyService>;
}

/** Determine if a model is available based on access mode and keys. */
async function isModelAvailable(
  model: string,
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): Promise<boolean> {
  // openRouterOnly models always need OpenRouter key
  if (config.openRouterOnly) return ctx.hasOpenRouter;

  // Check server-side relay availability
  if (
    ctx.hasServerAccess &&
    ctx.serverSideKeyService.isProviderOnServer(config.provider) &&
    ctx.serverSideKeyService.canUseModelSync(model)
  ) {
    return true;
  }

  // Fall back to personal API keys when:
  // - User explicitly chose "Use My Own Keys", OR
  // - User has default "Use Included Access" but isn't actually authenticated with server access
  //   (avoids showing all models as disabled for unauthenticated users)
  if (!ctx.useIncludedAccess || !ctx.hasServerAccess) {
    return hasPersonalKeyForModel(config, ctx.hasOpenRouter);
  }

  return false;
}

async function buildAvailabilityContext(): Promise<ModelAvailabilityContext> {
  const serverSideKeyService = getServerSideKeyService();
  const [hasOpenRouter, hasServerAccess] = await Promise.all([
    apiKeyExists(platform().secrets, 'openRouter'),
    serverSideKeyService.canUseServerSideKeys(),
  ]);
  return {
    hasOpenRouter,
    hasServerAccess,
    useIncludedAccess: serverSideKeyService.getUseIncludedModelAccess(),
    serverSideKeyService,
  };
}

/** Returns a human-readable reason why a model is unavailable, or `null` if available. */
export async function getModelUnavailableReason(
  model: string,
): Promise<string | null> {
  const config = MODEL_CONFIGS[model];
  if (!config) return `Model "${model}" is not recognized.`;

  const ctx = await buildAvailabilityContext();
  const available = await isModelAvailable(model, config, ctx);
  if (available) return null;

  // Determine the specific reason
  if (config.openRouterOnly) {
    return `Model "${model}" requires an OpenRouter API key. Set your OpenRouter key in the extension settings.`;
  }

  if (ctx.useIncludedAccess && ctx.hasServerAccess) {
    // User has server access but model isn't available on their tier
    return `Model "${model}" is not available with your current subscription tier. Upgrade your plan or switch to a different model.`;
  }

  // Personal key mode or unauthenticated — missing provider key
  const providerName =
    PROVIDER_DISPLAY_NAMES[config.provider] ?? config.provider;
  return `Model "${model}" requires your ${providerName} API key. Set it in the extension settings or enable included access.`;
}

/** Build typed model option data for a single model. */
async function buildModelOptionData(
  model: string,
  ctx: ModelAvailabilityContext,
): Promise<ModelOptionData> {
  const config = MODEL_CONFIGS[model];
  if (!config) {
    return { value: model, label: model };
  }

  const available = await isModelAvailable(model, config, ctx);
  return {
    value: model,
    label: config.label,
    provider: config.provider,
    context: formatContext(config.contextWindow),
    cost: formatCost(config.inputPrice, config.outputPrice),
    hint: buildModelHint(config),
    requiresKey: !available,
    disabled: !available,
  };
}

/**
 * Build basic model options from static config only (synchronous).
 * Includes provider, context, and cost metadata but skips async
 * availability checks. All models are shown as enabled.
 */
export function buildBasicModelOptionsData(): ModelOptionData[] {
  return getVisibleModels().map((model) => {
    const config = MODEL_CONFIGS[model];
    if (!config) return { value: model, label: model };
    return {
      value: model,
      label: config.label,
      provider: config.provider,
      context: formatContext(config.contextWindow),
      cost: formatCost(config.inputPrice, config.outputPrice),
      hint: buildModelHint(config),
    };
  });
}

/**
 * TTL-based cache for computeModelOptionsData.
 * Avoids redundant async work (SecretManager + server-side key checks)
 * when multiple callers request model options in quick succession.
 *
 * State is split into resolved data vs in-flight promise to avoid
 * sentinel values (like `data: []`) that could leak to callers.
 */
const MODEL_OPTIONS_CACHE_TTL_MS = 5_000;
let _resolved: { data: ModelOptionData[]; expiry: number } | null = null;
let _pending: Promise<ModelOptionData[]> | null = null;

/** Invalidate the shared model options cache (e.g. after key or model-list changes). */
export function invalidateModelOptionsCache(): void {
  _resolved = null;
  _pending = null;
}

/** Compute typed model options data for Lit-native rendering. */
export async function computeModelOptionsData(): Promise<ModelOptionData[]> {
  if (_resolved && Date.now() < _resolved.expiry) return _resolved.data;
  if (_pending) return _pending;

  const request = computeModelOptionsDataUncached();
  _pending = request;

  try {
    const data = await request;
    // Only populate cache if no invalidation occurred while we were awaiting.
    if (_pending === request) {
      _resolved = { data, expiry: Date.now() + MODEL_OPTIONS_CACHE_TTL_MS };
    }
    return data;
  } finally {
    if (_pending === request) _pending = null;
  }
}

async function computeModelOptionsDataUncached(): Promise<ModelOptionData[]> {
  const models = getVisibleModels();
  const availabilityCtx = await buildAvailabilityContext();

  return Promise.all(
    models.map((model) => buildModelOptionData(model, availabilityCtx)),
  );
}
