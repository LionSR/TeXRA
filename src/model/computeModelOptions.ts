// Third-party imports
import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

// Local imports - platform
import { platform } from '@platform/platform';

// Local imports - auth
import { getServerSideKeyService } from '@auth/serverKeys';

// Local imports - state
// Local imports - shared schemas
import type { ModelOptionData } from '@shared/schemas';

// Local imports - shared constants
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';

// Local imports - sibling
import { API_PROVIDERS, apiKeyExists, type ApiProvider } from './apiProviders';
import {
  buildModelHint,
  formatContext,
  formatCost,
  getVisibleModels,
} from './modelOptionsBasic';

export { isDeprecatedModel } from './modelOptionsBasic';

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
