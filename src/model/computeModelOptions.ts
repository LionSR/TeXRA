import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

import { platform } from '@platform/platform';
import { getServerSideKeyService } from '@auth/serverKeys';
import type { ModelAvailabilityKind, ModelOptionData } from '@shared/schemas';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import { apiKeyExists, isApiProvider } from './apiProviders';
import { buildBaseModelOption, getVisibleModels } from './modelOptionsBasic';
import { shouldRouteModelThroughOpenRouter } from './openRouterRouting';

type PersonalModelAccessKind = 'provider-key' | 'openrouter-key';

interface ModelAvailabilityStatus {
  kind: ModelAvailabilityKind;
  label: string;
  available: boolean;
  requiresKey: boolean;
}

const AVAILABILITY_STATUS: Record<
  ModelAvailabilityKind,
  ModelAvailabilityStatus
> = {
  'openrouter-key': {
    kind: 'openrouter-key',
    label: 'OpenRouter key',
    available: true,
    requiresKey: false,
  },
  'provider-key': {
    kind: 'provider-key',
    label: 'API key set',
    available: true,
    requiresKey: false,
  },
  'included-access': {
    kind: 'included-access',
    label: 'Included access',
    available: true,
    requiresKey: false,
  },
  'missing-key': {
    kind: 'missing-key',
    label: 'Missing API key',
    available: false,
    requiresKey: true,
  },
  'not-included': {
    kind: 'not-included',
    label: 'Not included',
    available: false,
    requiresKey: false,
  },
  'included-login-required': {
    kind: 'included-login-required',
    label: 'Login required',
    available: false,
    requiresKey: false,
  },
  'relay-quota-exhausted': {
    kind: 'relay-quota-exhausted',
    label: 'Relay quota exhausted',
    available: false,
    requiresKey: false,
  },
};

/** Check whether a model is available through a personal provider or OpenRouter key. */
async function getPersonalAccessKindForModel(
  config: ModelConfig,
  hasOpenRouter: boolean,
): Promise<PersonalModelAccessKind | null> {
  const { provider } = config;
  if (!isApiProvider(provider)) {
    return 'provider-key';
  }

  try {
    if (await apiKeyExists(platform().secrets, provider)) {
      return 'provider-key';
    }
  } catch {
    // Treat unreadable provider keys as absent, but still allow OpenRouter
    // fallback below when this model has an OpenRouter route.
  }

  return config.openrouterFullName && hasOpenRouter ? 'openrouter-key' : null;
}

interface ModelAvailabilityContext {
  hasOpenRouter: boolean;
  hasServerAccess: boolean;
  relayQuotaExhausted: boolean;
  useOpenRouter: boolean;
  useIncludedAccess: boolean;
  serverSideKeyService: ReturnType<typeof getServerSideKeyService>;
}

function canUseIncludedAccessForModel(
  model: string,
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): boolean {
  return (
    ctx.hasServerAccess &&
    ctx.serverSideKeyService.isProviderOnServer(config.provider) &&
    ctx.serverSideKeyService.canUseModelSync(model)
  );
}

/** Determine how a model can be used in the current access mode. */
async function resolveModelAvailability(
  model: string,
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): Promise<ModelAvailabilityStatus> {
  // OpenRouter routing is intentionally outside included access; a configured
  // OpenRouter key is the only ready state for these calls.
  if (shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)) {
    return ctx.hasOpenRouter
      ? AVAILABILITY_STATUS['openrouter-key']
      : AVAILABILITY_STATUS['missing-key'];
  }

  if (ctx.relayQuotaExhausted) {
    return AVAILABILITY_STATUS['relay-quota-exhausted'];
  }

  if (canUseIncludedAccessForModel(model, config, ctx)) {
    return AVAILABILITY_STATUS['included-access'];
  }

  // Fall back to personal API keys when the user opted out of included access
  // OR they aren't authenticated for it (avoids showing every model as
  // disabled for unauthenticated users with the default setting).
  if (ctx.useIncludedAccess && ctx.hasServerAccess) {
    return AVAILABILITY_STATUS['not-included'];
  }

  const personalAccess = await getPersonalAccessKindForModel(
    config,
    ctx.hasOpenRouter,
  );
  return personalAccess
    ? AVAILABILITY_STATUS[personalAccess]
    : AVAILABILITY_STATUS['missing-key'];
}

async function buildAvailabilityContext(): Promise<ModelAvailabilityContext> {
  const serverSideKeyService = getServerSideKeyService();
  const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();
  const [hasOpenRouter, hasServerAccess] = await Promise.all([
    apiKeyExists(platform().secrets, 'openRouter'),
    serverSideKeyService.canUseServerSideKeys(),
  ]);
  return {
    hasOpenRouter,
    hasServerAccess,
    relayQuotaExhausted:
      serverSideKeyService.wasQuotaAutoSwitched() ||
      (useIncludedAccess && serverSideKeyService.isRelayQuotaExceeded()),
    useOpenRouter: getUseOpenRouter(),
    useIncludedAccess,
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
  const availability = await resolveModelAvailability(model, config, ctx);
  if (availability.available) return null;

  // Determine the specific reason
  if (shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)) {
    return `Model "${model}" requires an OpenRouter API key.`;
  }

  if (availability.kind === 'not-included') {
    // User has server access but model isn't available on their tier
    return `Model "${model}" is not available with your current subscription tier. Upgrade your plan or switch to a different model.`;
  }

  if (availability.kind === 'relay-quota-exhausted') {
    return `Model "${model}" is unavailable because your monthly TeXRA relay quota is exhausted. Switch to personal API keys or wait for the next quota period.`;
  }

  // Personal key mode or unauthenticated — missing provider key
  const providerName =
    PROVIDER_DISPLAY_NAMES[config.provider] ?? config.provider;
  return `Model "${model}" requires your ${providerName} API key. Provide it, or enable included access.`;
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

  const availability = await resolveModelAvailability(model, config, ctx);
  return {
    ...buildBaseModelOption(model, config),
    availability: availability.kind,
    availabilityLabel: availability.label,
    requiresKey: availability.requiresKey,
    disabled: !availability.available,
  };
}

const MODEL_OPTIONS_CACHE_TTL_MS = 5_000;
const VISIBLE_MODELS_CACHE_KEY = 'visible';
const EXPLICIT_MODELS_CACHE_PREFIX = 'models:';

/**
 * TTL-based cache for computeModelOptionsData.
 * Avoids redundant async work (SecretManager + server-side key checks)
 * when multiple callers request model options in quick succession.
 *
 * State is split into resolved data vs in-flight promise to avoid
 * sentinel values (like `data: []`) that could leak to callers.
 */
const resolvedModelOptions = new Map<
  string,
  { data: ModelOptionData[]; expiry: number }
>();
const pendingModelOptions = new Map<string, Promise<ModelOptionData[]>>();

/** Invalidate the shared model options cache (e.g. after key or model-list changes). */
export function invalidateModelOptionsCache(): void {
  resolvedModelOptions.clear();
  pendingModelOptions.clear();
}

/**
 * Compute typed model options data for Lit-native rendering.
 *
 * When `models` is provided, the caller's view of the visible-models list is
 * honored verbatim. Explicit lists are cached by their exact ordered contents,
 * so alternate global-state views stay isolated while repeated settings/CLI
 * refreshes do not redo secret and server-side key checks.
 */
export async function computeModelOptionsData(
  models?: readonly string[],
): Promise<ModelOptionData[]> {
  const cacheKey = getModelOptionsCacheKey(models);
  const cached = resolvedModelOptions.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const pending = pendingModelOptions.get(cacheKey);
  if (pending) return pending;

  const request = computeModelOptionsDataUncached(models);
  pendingModelOptions.set(cacheKey, request);

  try {
    const data = await request;
    // Only populate cache if no invalidation occurred while we were awaiting.
    if (pendingModelOptions.get(cacheKey) === request) {
      resolvedModelOptions.set(cacheKey, {
        data,
        expiry: Date.now() + MODEL_OPTIONS_CACHE_TTL_MS,
      });
    }
    return data;
  } finally {
    if (pendingModelOptions.get(cacheKey) === request) {
      pendingModelOptions.delete(cacheKey);
    }
  }
}

function getModelOptionsCacheKey(models?: readonly string[]): string {
  return models == null
    ? VISIBLE_MODELS_CACHE_KEY
    : `${EXPLICIT_MODELS_CACHE_PREFIX}${JSON.stringify(models)}`;
}

async function computeModelOptionsDataUncached(
  modelsOverride?: readonly string[],
): Promise<ModelOptionData[]> {
  const models = modelsOverride ?? getVisibleModels();
  const availabilityCtx = await buildAvailabilityContext();

  return Promise.all(
    models.map((model) => buildModelOptionData(model, availabilityCtx)),
  );
}
