import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

import { platform } from '@platform/platform';
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  isCodexSignedIn,
  isPreferCodexSubscription,
  shouldUseCodexSubscription,
} from '@auth/codex';
import type { ModelAvailabilityKind, ModelOptionData } from '@shared/schemas';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import {
  apiKeyExists,
  apiKeyExistsUncached,
  isApiProvider,
  type ApiProvider,
} from './apiProviders';
import {
  buildBaseModelOption,
  buildBasicModelOptionsData,
} from './modelOptionsBasic';
import { getVisibleModels } from './modelOptionsState';
import { shouldRouteModelThroughOpenRouter } from './openRouterRouting';
import type { PlatformSecrets } from '@platform/secrets';

type PersonalModelAccessKind = 'provider-key' | 'openrouter-key';

export interface ModelOptionsServerAccess {
  canUseServerSideKeys(): Promise<boolean>;
  getUseIncludedModelAccess(): boolean;
  wasQuotaAutoSwitched(): boolean;
  isRelayQuotaExceeded(): boolean;
  isProviderOnServer(provider: string): boolean;
  canUseModelSync(model: string): boolean;
}

export interface ModelOptionsAccess {
  readonly visibleModels: readonly string[];
  readonly secrets: PlatformSecrets;
  readonly useOpenRouter: boolean;
  readonly serverSideKeyService: ModelOptionsServerAccess;
}

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
  'subscription-access': {
    kind: 'subscription-access',
    label: 'ChatGPT subscription',
    available: true,
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
  ctx: ModelAvailabilityContext,
): Promise<PersonalModelAccessKind | null> {
  const { provider } = config;
  if (!isApiProvider(provider)) {
    return 'provider-key';
  }

  try {
    if (await ctx.apiKeyExists(provider)) {
      return 'provider-key';
    }
  } catch {
    // Treat unreadable provider keys as absent, but still allow OpenRouter
    // fallback below when this model has an OpenRouter route.
  }

  return config.openrouterFullName && ctx.hasOpenRouter
    ? 'openrouter-key'
    : null;
}

interface ModelAvailabilityContext {
  apiKeyExists(provider: ApiProvider): Promise<boolean>;
  hasOpenRouter: boolean;
  hasServerAccess: boolean;
  relayQuotaExhausted: boolean;
  useOpenRouter: boolean;
  useIncludedAccess: boolean;
  /** Whether the user is signed in with ChatGPT (only resolved when the
   * "prefer subscription" switch is on). */
  codexSignedIn: boolean;
  serverSideKeyService: ModelOptionsServerAccess;
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
  // ChatGPT subscription (Codex) is a preference, not a hard requirement. When
  // the host is not signed in, continue through the normal API-key/relay paths
  // so the switch cannot disable models that are otherwise runnable.
  if (
    ctx.codexSignedIn &&
    shouldUseCodexSubscription(config, ctx.useOpenRouter)
  ) {
    return AVAILABILITY_STATUS['subscription-access'];
  }

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

  const personalAccess = await getPersonalAccessKindForModel(config, ctx);
  return personalAccess
    ? AVAILABILITY_STATUS[personalAccess]
    : AVAILABILITY_STATUS['missing-key'];
}

async function buildAvailabilityContext(
  access: ModelOptionsAccess,
  useApiKeyCache: boolean,
): Promise<ModelAvailabilityContext> {
  const { serverSideKeyService } = access;
  const hasApiKey = (provider: ApiProvider) =>
    useApiKeyCache
      ? apiKeyExists(access.secrets, provider)
      : apiKeyExistsUncached(access.secrets, provider);
  const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();
  const [hasOpenRouter, hasServerAccess, codexSignedIn] = await Promise.all([
    hasApiKey('openRouter'),
    serverSideKeyService.canUseServerSideKeys(),
    // Only worth a secrets read when the "prefer subscription" switch is on.
    isPreferCodexSubscription() ? isCodexSignedIn() : Promise.resolve(false),
  ]);
  return {
    apiKeyExists: hasApiKey,
    hasOpenRouter,
    hasServerAccess,
    relayQuotaExhausted:
      serverSideKeyService.wasQuotaAutoSwitched() ||
      (useIncludedAccess && serverSideKeyService.isRelayQuotaExceeded()),
    useOpenRouter: access.useOpenRouter,
    useIncludedAccess,
    codexSignedIn,
    serverSideKeyService,
  };
}

function buildDefaultModelOptionsAccess(): ModelOptionsAccess {
  const host = platform();
  return {
    visibleModels: getVisibleModels(host.globalState),
    secrets: host.secrets,
    useOpenRouter: getUseOpenRouter(),
    serverSideKeyService: getServerSideKeyService(),
  };
}

/** Build synchronous fallback options from the current host-visible model list. */
export function buildVisibleBasicModelOptionsData(
  visibleModels: readonly string[] = getVisibleModels(platform().globalState),
): ModelOptionData[] {
  return buildBasicModelOptionsData(visibleModels);
}

/** Returns a human-readable reason why a model is unavailable, or `null` if available. */
export async function getModelUnavailableReason(
  model: string,
  access?: ModelOptionsAccess,
): Promise<string | null> {
  const config = MODEL_CONFIGS[model];
  if (!config) return `Model "${model}" is not recognized.`;

  const effectiveAccess = access ?? buildDefaultModelOptionsAccess();
  const ctx = await buildAvailabilityContext(effectiveAccess, access == null);
  const availability = await resolveModelAvailability(model, config, ctx);
  if (availability.available) return null;

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
 *
 * Passing `access` computes directly from that dependency snapshot and skips
 * the shared TTL cache. Use it when the caller owns access-state freshness,
 * such as tests or host adapters with explicitly supplied state.
 */
export async function computeModelOptionsData(
  models?: readonly string[],
  access?: ModelOptionsAccess,
): Promise<ModelOptionData[]> {
  if (access) {
    return computeModelOptionsDataUncached(models, access, false);
  }

  const cacheKey = getModelOptionsCacheKey(models);
  const cached = resolvedModelOptions.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const pending = pendingModelOptions.get(cacheKey);
  if (pending) return pending;

  const request = computeModelOptionsDataUncached(
    models,
    buildDefaultModelOptionsAccess(),
    true,
  );
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
  modelsOverride: readonly string[] | undefined,
  access: ModelOptionsAccess,
  useApiKeyCache: boolean,
): Promise<ModelOptionData[]> {
  const models = modelsOverride ?? access.visibleModels;
  const availabilityCtx = await buildAvailabilityContext(
    access,
    useApiKeyCache,
  );

  return Promise.all(
    models.map((model) => buildModelOptionData(model, availabilityCtx)),
  );
}
