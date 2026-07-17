import { LRUCache } from 'lru-cache';

import { platform } from '@platform/platform';
import { getServerSideKeyService } from '@auth/serverKeys';
import { isCodexSignedIn, isPreferCodexSubscription } from '@auth/codex';
import type { ModelAvailabilityKind, ModelOptionData } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import {
  getPreferKimiCode,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

import {
  apiKeyExists,
  apiKeyExistsUncached,
  type ApiProvider,
} from './apiProviders';
import { resolveCodexSubscriptionCapabilitiesForAgentCategory } from './codexSubscriptionRouting';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  kimiCodeRuntimeConfig,
  resolveKimiCodeRoute,
} from './kimiCodeSubscriptionRouting';
import {
  buildBaseModelOption,
  buildBasicModelOptionsData,
} from './modelOptionsBasic';
import { getVisibleModels } from './modelOptionsState';
import {
  allowsModelRelay,
  isOpenRouterRoutingUnsupported,
  resolveDirectModelApiKeyProvider,
  resolveModelSource,
  shouldRouteModelThroughOpenRouter,
} from './openRouterRouting';
import {
  availableRuntimeModelIds,
  discoveredRuntimeModelConfigEntries,
  getRuntimeModelConfig,
  isRuntimeModel,
  runtimeModelAccess,
  runtimeModelConfigEntries,
} from './runtimeModelRegistry';
import type { ProviderCapabilityProfile } from './providerCapabilities';
import type { ModelConfig } from 'llm-zoo';
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
  readonly agentCategory?: AgentCategory;
}

export interface ModelOptionsComputationOptions {
  readonly agentCategory?: AgentCategory;
}

interface ModelAvailabilityStatus {
  kind: ModelAvailabilityKind;
  label: string;
  available: boolean;
  requiresKey: boolean;
  providerCapabilities?: ProviderCapabilityProfile;
}

/**
 * Per-kind status fields. `kind` is intentionally omitted here: the record key
 * is the single source of truth and `availabilityStatus()` reattaches it.
 */
const AVAILABILITY_STATUS_FIELDS: Record<
  ModelAvailabilityKind,
  Omit<ModelAvailabilityStatus, 'kind'>
> = {
  'openrouter-key': {
    label: 'OpenRouter key',
    available: true,
    requiresKey: false,
  },
  'provider-key': { label: 'API key set', available: true, requiresKey: false },
  'included-access': {
    label: 'Included access',
    available: true,
    requiresKey: false,
  },
  'missing-key': {
    label: 'Missing API key',
    available: false,
    requiresKey: true,
  },
  'not-included': {
    label: 'Not included',
    available: false,
    requiresKey: false,
  },
  'included-login-required': {
    label: 'Login required',
    available: false,
    requiresKey: false,
  },
  'subscription-access': {
    label: 'ChatGPT subscription',
    available: true,
    requiresKey: false,
  },
  'copilot-access': {
    label: 'Copilot subscription',
    available: true,
    requiresKey: false,
  },
  'copilot-consent-required': {
    label: 'Copilot consent required',
    available: false,
    requiresKey: false,
  },
  'copilot-unavailable': {
    label: 'Copilot unavailable',
    available: false,
    requiresKey: false,
  },
  'provider-unavailable': {
    label: 'Unavailable through selected provider',
    available: false,
    requiresKey: false,
  },
  'relay-quota-exhausted': {
    label: 'Relay quota exhausted',
    available: false,
    requiresKey: false,
  },
  retired: {
    label: 'Retired',
    available: false,
    requiresKey: false,
  },
};

/** Resolve a full availability status from its kind. */
function availabilityStatus(
  kind: ModelAvailabilityKind,
): ModelAvailabilityStatus {
  return { kind, ...AVAILABILITY_STATUS_FIELDS[kind] };
}

/** Check whether a model is available through a personal provider or OpenRouter key. */
async function getPersonalAccessKindForModel(
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): Promise<PersonalModelAccessKind | null> {
  const provider = resolveDirectModelApiKeyProvider(config);
  if (!provider) return null;

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
  /** Whether the "Prefer Kimi Code" switch is on. */
  preferKimiCode: boolean;
  /** Whether a Kimi Code console API key is stored. */
  kimiCodeKeySet: boolean;
  agentCategory?: AgentCategory;
  serverSideKeyService: ModelOptionsServerAccess;
}

/**
 * The config a Kimi-subscription-eligible model actually runs with, mirroring
 * ModelFactory's dispatch: when the shared route resolver picks the Kimi Code
 * endpoint for a dual-backend model (`kimi3`), swap in the synthesized runtime
 * config (coding base URL + `k3` wire id) so availability, the row's product
 * source, and the unavailable-reason all match what the handler builds.
 * Exclusive models already carry the pinned config, so this is only material
 * for dual-backend routes. Returns the original config otherwise.
 */
function effectiveKimiCodeConfig(
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): ModelConfig {
  if (!isKimiSubscriptionEligible(config)) return config;
  const route = resolveKimiCodeRoute(
    config,
    ctx.useOpenRouter,
    ctx.kimiCodeKeySet,
    ctx.preferKimiCode,
  );
  if (route === 'kimiCode' && !isKimiCodeExclusiveModel(config)) {
    return kimiCodeRuntimeConfig(config);
  }
  return config;
}

function canUseIncludedAccessForModel(
  model: string,
  config: ModelConfig,
  ctx: ModelAvailabilityContext,
): boolean {
  return (
    allowsModelRelay(config) &&
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
  if (config.retired) {
    return availabilityStatus('retired');
  }

  if (isRuntimeModel(model)) {
    switch (runtimeModelAccess(model)) {
      case 'allowed':
        return availabilityStatus('copilot-access');
      case 'consent-required':
        return availabilityStatus('copilot-consent-required');
      case 'unavailable':
      case undefined:
        return availabilityStatus('copilot-unavailable');
    }
  }

  if (isOpenRouterRoutingUnsupported(config, ctx.useOpenRouter)) {
    return {
      ...availabilityStatus('provider-unavailable'),
      label: 'Unavailable through OpenRouter',
    };
  }

  // ChatGPT subscription (Codex) is a preference, not a hard requirement. When
  // the host is not signed in, continue through the normal API-key/relay paths
  // so the switch cannot disable models that are otherwise runnable.
  if (ctx.codexSignedIn) {
    const subscriptionCapabilities =
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        config,
        ctx.useOpenRouter,
        ctx.agentCategory,
      );
    if (subscriptionCapabilities) {
      return {
        ...availabilityStatus('subscription-access'),
        providerCapabilities: subscriptionCapabilities,
      };
    }
  }

  // OpenRouter routing is intentionally outside included access; a configured
  // OpenRouter key is the only ready state for these calls.
  if (shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)) {
    return ctx.hasOpenRouter
      ? availabilityStatus('openrouter-key')
      : availabilityStatus('missing-key');
  }

  if (allowsModelRelay(config) && ctx.relayQuotaExhausted) {
    return availabilityStatus('relay-quota-exhausted');
  }

  if (canUseIncludedAccessForModel(model, config, ctx)) {
    return availabilityStatus('included-access');
  }

  // Fall back to personal API keys when the user opted out of included access
  // OR they aren't authenticated for it (avoids showing every model as
  // disabled for unauthenticated users with the default setting).
  if (
    allowsModelRelay(config) &&
    ctx.useIncludedAccess &&
    ctx.hasServerAccess
  ) {
    return availabilityStatus('not-included');
  }

  const personalAccess = await getPersonalAccessKindForModel(config, ctx);
  return personalAccess
    ? availabilityStatus(personalAccess)
    : availabilityStatus('missing-key');
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
  const [hasOpenRouter, hasServerAccess, codexSignedIn, kimiCodeKeySet] =
    await Promise.all([
      hasApiKey('openRouter'),
      serverSideKeyService.canUseServerSideKeys(),
      // Only worth a secrets read when the "prefer subscription" switch is on.
      isPreferCodexSubscription() ? isCodexSignedIn() : Promise.resolve(false),
      hasApiKey('kimiCode'),
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
    preferKimiCode: getPreferKimiCode(),
    kimiCodeKeySet,
    agentCategory: access.agentCategory,
    serverSideKeyService,
  };
}

function buildDefaultModelOptionsAccess(
  options: ModelOptionsComputationOptions = {},
): ModelOptionsAccess {
  const host = platform();
  return {
    visibleModels: getVisibleModels(host.globalState),
    secrets: host.secrets,
    useOpenRouter: getUseOpenRouter(),
    serverSideKeyService: getServerSideKeyService(),
    agentCategory: options.agentCategory,
  };
}

function applyModelOptionsComputationOptions(
  access: ModelOptionsAccess,
  options: ModelOptionsComputationOptions,
): ModelOptionsAccess {
  if (options.agentCategory === undefined) return access;
  return { ...access, agentCategory: options.agentCategory };
}

/**
 * Build synchronous fallback options from the current host-visible model list.
 *
 * Secret-free by design (no key reads), so it cannot resolve credential-
 * dependent routing: a dual-backend model like `kimi3` shows its canonical
 * provider home (Moonshot), and the async {@link computeModelOptionsData}
 * refines it to Kimi Code when "Prefer Kimi Code" plus a stored key actually
 * reroute it. Exclusive Kimi Code models still show `kimiCode` here because
 * that is a pure registry fact needing no secret.
 */
export function buildVisibleBasicModelOptionsData(
  visibleModels: readonly string[] = getVisibleModels(platform().globalState),
): ModelOptionData[] {
  return buildBasicModelOptionsData(visibleModels);
}

/** Returns a human-readable reason why a model is unavailable, or `null` if available. */
export async function getModelUnavailableReason(
  model: string,
  access?: ModelOptionsAccess,
  options: ModelOptionsComputationOptions = {},
): Promise<string | null> {
  await discoveredRuntimeModelConfigEntries();
  const rawConfig = getRuntimeModelConfig(model);
  if (!rawConfig) return `Model "${model}" is not recognized.`;

  // buildDefaultModelOptionsAccess already folds in options.agentCategory, so
  // only the caller-supplied access path needs the option override reapplied.
  const effectiveAccess = access
    ? applyModelOptionsComputationOptions(access, options)
    : buildDefaultModelOptionsAccess(options);
  const ctx = await buildAvailabilityContext(effectiveAccess, access == null);
  const config = effectiveKimiCodeConfig(rawConfig, ctx);
  const availability = await resolveModelAvailability(model, config, ctx);
  if (availability.available) return null;

  if (availability.kind === 'retired') {
    return `Model "${model}" is retired and no longer available from its provider. Choose an active model.`;
  }

  if (isOpenRouterRoutingUnsupported(config, ctx.useOpenRouter)) {
    return `Model "${model}" requires a provider request mode that OpenRouter does not support. Disable OpenRouter and use the provider API directly.`;
  }

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

  if (availability.kind === 'copilot-consent-required') {
    return `Model "${model}" needs your consent before TeXRA can use it through Copilot in VS Code.`;
  }

  if (availability.kind === 'copilot-unavailable') {
    return `Model "${model}" is currently unavailable through Copilot in VS Code.`;
  }

  // Personal key mode or unauthenticated — missing key or keyless provider.
  const directProvider = resolveDirectModelApiKeyProvider(config);
  const modelSource = resolveModelSource(config) ?? config.provider;
  const providerName = PROVIDER_DISPLAY_NAMES[modelSource] ?? modelSource;
  if (!directProvider) {
    return `Model "${model}" is provided by ${providerName}, which does not use provider API keys. Use a host that supports ${providerName} models or choose another model.`;
  }
  const nextStep = allowsModelRelay(config)
    ? 'Provide it, or enable included access.'
    : 'Provide it to continue.';
  return `Model "${model}" requires your ${providerName} API key. ${nextStep}`;
}

/** Build typed model option data for a single model. */
async function buildModelOptionData(
  model: string,
  ctx: ModelAvailabilityContext,
): Promise<ModelOptionData> {
  const rawConfig = getRuntimeModelConfig(model);
  if (!rawConfig) {
    return { value: model, label: model };
  }
  // Mirror ModelFactory: a dual-backend Kimi model routed to the coding
  // endpoint runs with the synthesized runtime config, so the row reflects it.
  const config = effectiveKimiCodeConfig(rawConfig, ctx);

  const availability = await resolveModelAvailability(model, config, ctx);
  const optionConfig = availability.providerCapabilities
    ? {
        ...config,
        contextWindow: availability.providerCapabilities.contextWindow,
        inputPrice: availability.providerCapabilities.inputPrice,
        outputPrice: availability.providerCapabilities.outputPrice,
      }
    : config;
  return {
    ...buildBaseModelOption(model, optionConfig, config),
    availability: availability.kind,
    availabilityLabel: availability.label,
    requiresKey: availability.requiresKey,
    disabled: !availability.available,
  };
}

const MODEL_OPTIONS_CACHE_TTL_MS = 5_000;
const MODEL_OPTIONS_CACHE_MAX_ENTRIES = 50;
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
const resolvedModelOptions = new LRUCache<string, ModelOptionData[]>({
  max: MODEL_OPTIONS_CACHE_MAX_ENTRIES,
  ttl: MODEL_OPTIONS_CACHE_TTL_MS,
});
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
  options: ModelOptionsComputationOptions = {},
): Promise<ModelOptionData[]> {
  if (access) {
    return computeModelOptionsDataUncached(
      models,
      applyModelOptionsComputationOptions(access, options),
      false,
    );
  }

  const cacheKey = getModelOptionsCacheKey(models, options);
  const cached = resolvedModelOptions.get(cacheKey);
  if (cached) return cached;

  const pending = pendingModelOptions.get(cacheKey);
  if (pending) return pending;

  const request = computeModelOptionsDataUncached(
    models,
    buildDefaultModelOptionsAccess(options),
    true,
  );
  pendingModelOptions.set(cacheKey, request);

  try {
    const data = await request;
    // Only populate cache if no invalidation occurred while we were awaiting.
    if (pendingModelOptions.get(cacheKey) === request) {
      resolvedModelOptions.set(cacheKey, data);
    }
    return data;
  } finally {
    if (pendingModelOptions.get(cacheKey) === request) {
      pendingModelOptions.delete(cacheKey);
    }
  }
}

function getModelOptionsCacheKey(
  models: readonly string[] | undefined,
  options: ModelOptionsComputationOptions,
): string {
  const listKey =
    models == null
      ? VISIBLE_MODELS_CACHE_KEY
      : `${EXPLICIT_MODELS_CACHE_PREFIX}${JSON.stringify(models)}`;
  return options.agentCategory === undefined
    ? listKey
    : `${listKey}:category:${options.agentCategory}`;
}

async function computeModelOptionsDataUncached(
  modelsOverride: readonly string[] | undefined,
  access: ModelOptionsAccess,
  useApiKeyCache: boolean,
): Promise<ModelOptionData[]> {
  await discoveredRuntimeModelConfigEntries();
  const availabilityCtx = await buildAvailabilityContext(
    access,
    useApiKeyCache,
  );
  const models =
    modelsOverride ??
    visibleModelsForAccess(access.visibleModels, availabilityCtx);

  return Promise.all(
    models.map((model) => buildModelOptionData(model, availabilityCtx)),
  );
}

function visibleModelsForAccess(
  configuredModels: readonly string[],
  context: ModelAvailabilityContext,
): readonly string[] {
  const models = new Set([...configuredModels, ...availableRuntimeModelIds()]);
  if (!context.codexSignedIn) return [...models];

  for (const [model, config] of runtimeModelConfigEntries()) {
    if (
      !config.retired &&
      !config.deprecated &&
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        config,
        context.useOpenRouter,
        context.agentCategory,
      ) !== null
    ) {
      models.add(model);
    }
  }
  return [...models];
}
