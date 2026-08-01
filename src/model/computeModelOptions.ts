import { LRUCache } from 'lru-cache';

import {
  includedModelAccess,
  type IncludedModelAccess,
} from '@model/includedModelAccess';
import { isCodexSignedIn } from '@model/codex/codexSignedIn';
import { isPreferCodexSubscription } from '@model/codex/codexPreference';
import type { StateStore } from '@platform/interfaces';
import { platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';
import type { ModelAvailabilityKind, ModelOptionData } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { coalesceAsync } from '@utils/core';
import {
  getPreferKimiCode,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

import {
  apiKeyExists,
  apiKeyExistsUncached,
  type ApiProvider,
} from './apiProviders';
import { resolveCodexSubscriptionCapabilitiesForAgentCategory } from './providerCapabilities';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  kimiCodeRuntimeConfig,
  resolveKimiCodeRoute,
} from './kimiCodeSubscriptionRouting';
import {
  buildBaseModelOption,
  buildBasicModelOptionsData,
  DEFAULT_MODELS,
} from './modelOptionsBasic';
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

type PersonalModelAccessKind = 'provider-key' | 'openrouter-key';

/**
 * The slice of {@link IncludedModelAccess} model availability reads: whether
 * included access is on, whether the account can use it, and which
 * providers/models it covers. Derived rather than redeclared so a caller can
 * always pass the installed provider, while a test — and the picker's own
 * narrower contract — stays free of the credential and routing members that
 * only request construction needs.
 */
export type ModelOptionsServerAccess = Pick<
  IncludedModelAccess,
  | 'canUseServerSideKeys'
  | 'getUseIncludedModelAccess'
  | 'isAuthenticated'
  | 'wasQuotaAutoSwitched'
  | 'isRelayQuotaExceeded'
  | 'isProviderOnServer'
  | 'canUseModelSync'
>;

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
 *
 * Declared with `satisfies` rather than a `Record<...>` type annotation so
 * each entry's `available` literal (`true`/`false`) survives into
 * {@link UnavailableAvailabilityKind} below — an annotation would widen it to
 * `boolean` and break that derivation — while `satisfies` still rejects a
 * missing or misshapen kind exactly like the annotation did.
 */
const AVAILABILITY_STATUS_FIELDS = {
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
  'unknown-model': {
    label: 'Unknown model',
    available: false,
    requiresKey: false,
  },
} satisfies Record<ModelAvailabilityKind, Omit<ModelAvailabilityStatus, 'kind'>>;

/** Resolve a full availability status from its kind. */
function availabilityStatus(
  kind: ModelAvailabilityKind,
): ModelAvailabilityStatus {
  return { kind, ...AVAILABILITY_STATUS_FIELDS[kind] };
}

/**
 * Every kind whose {@link AVAILABILITY_STATUS_FIELDS} entry is
 * `available: false` — derived, not hand-listed, so a kind can't be added to
 * one table (or have its `available` flip) without the other noticing.
 */
type UnavailableAvailabilityKind = {
  [K in ModelAvailabilityKind]: (typeof AVAILABILITY_STATUS_FIELDS)[K]['available'] extends true
    ? never
    : K;
}[ModelAvailabilityKind];

/** Everything an unavailable-reason builder needs to reconstruct the exact
 *  wording `getModelUnavailableReason` used to hand-roll per branch. */
interface UnavailableReasonContext {
  readonly model: string;
  readonly config: ModelConfig;
  readonly ctx: ModelAvailabilityContext;
}

/**
 * Per-kind unavailable-reason prose, compiler-checked the same way
 * {@link AVAILABILITY_STATUS_FIELDS} is: omitting a kind here — including a
 * newly added `ModelAvailabilityKind` whose status is `available: false` —
 * is a type error instead of a silent fall-through to a generic message.
 */
const UNAVAILABLE_REASON_BUILDERS: Record<
  UnavailableAvailabilityKind,
  (reasonCtx: UnavailableReasonContext) => string
> = {
  retired: ({ model }) =>
    `Model "${model}" is retired and no longer available from its provider. Choose an active model.`,
  'provider-unavailable': ({ model }) =>
    `Model "${model}" requires a provider request mode that OpenRouter does not support. Disable OpenRouter and use the provider API directly.`,
  'missing-key': ({ model, config, ctx }) => {
    if (shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)) {
      return `Model "${model}" requires an OpenRouter API key.`;
    }
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
  },
  'not-included': ({ model }) =>
    `Model "${model}" is not available with your current subscription tier. Upgrade your plan or switch to a different model.`,
  'included-login-required': ({ model }) =>
    `Model "${model}" is served by included TeXRA model access, which needs an account. Sign in, or provide a provider API key and switch to personal API keys.`,
  'relay-quota-exhausted': ({ model }) =>
    `Model "${model}" is unavailable because your monthly TeXRA relay quota is exhausted. Switch to personal API keys or wait for the next quota period.`,
  'copilot-consent-required': ({ model }) =>
    `Model "${model}" needs your consent before TeXRA can use it through Copilot in VS Code.`,
  'copilot-unavailable': ({ model }) =>
    `Model "${model}" is currently unavailable through Copilot in VS Code.`,
  // Unreachable from `getModelUnavailableReason` today (it returns its own
  // "not recognized" message before a config resolves far enough to compute
  // availability at all), but the table must still cover it: `unknown-model`
  // is `available: false`, so leaving it out would defeat the whole point of
  // this table being compiler-checked.
  'unknown-model': ({ model }) => `Model "${model}" is not recognized.`,
};

/**
 * Ship the resolved verdict on the option row. Every option leaves this
 * module with all four fields set, so no renderer ever has to guess a label
 * for a row that only carries `value` and `label`.
 */
function withAvailabilityFields(
  option: ModelOptionData,
  availability: ModelAvailabilityStatus,
): ModelOptionData {
  return {
    ...option,
    availability: availability.kind,
    availabilityLabel: availability.label,
    requiresKey: availability.requiresKey,
    disabled: !availability.available,
  };
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
  /**
   * Whether included access is selected while no account session exists, so
   * the honest reason a relay-served model cannot run is "sign in" rather
   * than "missing API key".
   */
  includedAccessSignedOut: boolean;
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
    // The relay only owns the model when included access can actually serve
    // it — mirrors ModelFactory's dispatch facts.
    ctx.useIncludedAccess && ctx.hasServerAccess,
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
  if (personalAccess) return availabilityStatus(personalAccess);

  if (ctx.includedAccessSignedOut && allowsModelRelay(config)) {
    return availabilityStatus('included-login-required');
  }
  return availabilityStatus('missing-key');
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
  const [
    hasOpenRouter,
    hasServerAccess,
    codexSignedIn,
    kimiCodeKeySet,
    includedAccessSignedOut,
  ] = await Promise.all([
    hasApiKey('openRouter'),
    serverSideKeyService.canUseServerSideKeys(),
    // Only worth a secrets read when the "prefer subscription" switch is on.
    isPreferCodexSubscription() ? isCodexSignedIn() : Promise.resolve(false),
    hasApiKey('kimiCode'),
    // Signed-out is only a distinct availability reason on the included-access
    // route, so personal mode never pays for this read.
    useIncludedAccess
      ? serverSideKeyService.isAuthenticated().then((authed) => !authed)
      : Promise.resolve(false),
  ]);
  return {
    apiKeyExists: hasApiKey,
    hasOpenRouter,
    hasServerAccess,
    includedAccessSignedOut,
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

/** Read the enabled model list from host state at the composition boundary. */
function getVisibleModels(state: Pick<StateStore, 'get'>): string[] {
  return state.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS);
}

function buildDefaultModelOptionsAccess(
  options: ModelOptionsComputationOptions = {},
): ModelOptionsAccess {
  const host = platform();
  return {
    visibleModels: getVisibleModels(host.globalState),
    secrets: host.secrets,
    useOpenRouter: getUseOpenRouter(),
    serverSideKeyService: includedModelAccess(),
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

  // `availability.kind` is guaranteed `available: false` here, so it's a
  // valid `UnavailableAvailabilityKind` and every case is covered by
  // `UNAVAILABLE_REASON_BUILDERS` — the compiler, not this call site, is what
  // enforces that a newly added unavailable kind gets a reason.
  const kind = availability.kind as UnavailableAvailabilityKind;
  return UNAVAILABLE_REASON_BUILDERS[kind]({ model, config, ctx });
}

/** Build typed model option data for a single model. */
async function buildModelOptionData(
  model: string,
  ctx: ModelAvailabilityContext,
): Promise<ModelOptionData> {
  const rawConfig = getRuntimeModelConfig(model);
  if (!rawConfig) {
    return withAvailabilityFields(
      { value: model, label: model },
      availabilityStatus('unknown-model'),
    );
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
  let routeLabel: string | undefined;
  if (
    isKimiSubscriptionEligible(rawConfig) &&
    !isKimiCodeExclusiveModel(rawConfig)
  ) {
    if (shouldRouteModelThroughOpenRouter(config, ctx.useOpenRouter)) {
      routeLabel = 'Via OpenRouter';
    } else {
      const source = resolveModelSource(config) ?? config.provider;
      routeLabel = `Via ${PROVIDER_DISPLAY_NAMES[source] ?? source}`;
    }
  }
  return withAvailabilityFields(
    {
      ...buildBaseModelOption(model, optionConfig, config),
      ...(routeLabel ? { routeLabel } : {}),
    },
    availability,
  );
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
  return coalesceAsync<string, ModelOptionData[]>(
    resolvedModelOptions,
    pendingModelOptions,
    cacheKey,
    () =>
      computeModelOptionsDataUncached(
        models,
        buildDefaultModelOptionsAccess(options),
        true,
      ),
  );
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
