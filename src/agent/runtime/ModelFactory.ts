import { ModelProvider, type ModelConfig } from 'llm-zoo';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';

import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { LEVEL_TO_EFFORT } from '@agent/modelHandlers/support/reasoningEffort';
import {
  internalValidationModelHandlerEnvName,
  shouldUseInternalValidationModelHandler,
} from '@agent/runtime/internalValidationOverride';
import type { ResponseTextProcessing } from '@agent/runtime/responseTextProcessing';
import {
  CodexAuthError,
  formatCodexAuthUnavailableMessage,
  isCodexSessionRoutable,
} from '@auth/codex';
import { AgentError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import {
  copilotRouteUnavailableReason,
  prefersCopilotRoute,
  type CopilotRouteOverride,
} from '@model/copilotRouting';
import { resolveCodexSubscriptionCapabilities } from '@model/providerCapabilities';
import {
  isKimiSubscriptionEligible,
  kimiCodeEffectiveConfig,
  resolveKimiCodeRoutingFacts,
} from '@model/kimiCodeSubscriptionRouting';
import { isGpt5ModelName } from '@model/modelNames';
import {
  isOpenRouterRoutingUnsupported,
  shouldRouteModelThroughOpenRouter,
  type ResolvedModelConfig,
} from '@model/openRouterRouting';
import { copilotRouteForModel } from '@model/runtimeModelRegistry';
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
} from '@platform/languageModel';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { getConfig } from '@utils/config/configUtils';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

const log = createLog('ModelFactory');

type ModelHandlerConstructor = new (
  config: ModelConfig,
  responseTextProcessing?: ResponseTextProcessing,
) => ModelHandler<ProviderMessage>;

type ProviderHandlerLoader = () => Promise<ModelHandlerConstructor>;

interface ProviderHandlerRoute {
  readonly load: ProviderHandlerLoader;
  readonly compatibilityKey: ModelHandlerCompatibilityKey;
}

const MODEL_HANDLER_COMPATIBILITY_PROPERTY =
  '__texraModelHandlerCompatibilityKey';

type ModelHandlerCompatibilityTagged = object & {
  readonly [MODEL_HANDLER_COMPATIBILITY_PROPERTY]?:
    | ModelHandlerCompatibilityKey
    | undefined;
};

// Record (not Map) so TypeScript enforces exhaustiveness over ModelProvider.
// A new enum value in llm-zoo without an entry here will fail typecheck.
const PROVIDER_HANDLER_ROUTES: Record<ModelProvider, ProviderHandlerRoute> = {
  [ModelProvider.ANTHROPIC]: {
    load: async () =>
      (await import('@agent/modelHandlers/anthropic/modelHandlerAnthropic'))
        .ModelHandlerAnthropic,
    compatibilityKey: 'ModelHandlerAnthropic',
  },
  [ModelProvider.OPENAI]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerOpenAI'))
        .ModelHandlerOpenAI,
    compatibilityKey: 'ModelHandlerOpenAI',
  },
  [ModelProvider.GOOGLE]: {
    load: async () =>
      (
        await import('@agent/modelHandlers/google/modelHandlerGoogleInteractions')
      ).ModelHandlerGoogleInteractions,
    compatibilityKey: 'ModelHandlerGoogleInteractions',
  },
  [ModelProvider.DEEPSEEK]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerDeepSeek'))
        .ModelHandlerDeepSeek,
    compatibilityKey: 'ModelHandlerDeepSeek',
  },
  [ModelProvider.XAI]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerXAI'))
        .ModelHandlerXAI,
    compatibilityKey: 'ModelHandlerXAI',
  },
  [ModelProvider.MOONSHOT]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerKimi'))
        .ModelHandlerKimi,
    compatibilityKey: 'ModelHandlerKimi',
  },
  [ModelProvider.DASHSCOPE]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerDashScope'))
        .ModelHandlerDashScope,
    compatibilityKey: 'ModelHandlerDashScope',
  },
  [ModelProvider.MINIMAX]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerMiniMax'))
        .ModelHandlerMiniMax,
    compatibilityKey: 'ModelHandlerMiniMax',
  },
  [ModelProvider.GLM]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerGLM'))
        .ModelHandlerGLM,
    compatibilityKey: 'ModelHandlerGLM',
  },
  [ModelProvider.META]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerOpenAIResponse'))
        .ModelHandlerOpenAIResponse,
    compatibilityKey: 'ModelHandlerMeta',
  },
  [ModelProvider.OTHERS]: {
    load: async () =>
      (
        await import('@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative')
      ).ModelHandlerOpenRouterNative,
    compatibilityKey: 'ModelHandlerOpenRouterNative',
  },
  [ModelProvider.COPILOT]: {
    load: async () =>
      (await import('@agent/modelHandlers/vscodelm/modelHandlerVscodeLm'))
        .ModelHandlerVscodeLm,
    compatibilityKey: 'ModelHandlerVscodeLm',
  },
};

/**
 * Apply the user's reasoning level override to a handler, returning it for chaining.
 * Only mutates capabilities when the handler reports `supportsReasoningLevelOverride`
 * (configurable effort, or DeepSeek-style reasoning without a granular effort flag)
 * and the user has set an override.
 */
function withReasoningOverride<T extends ModelHandler>(handler: T): T {
  if (!handler.supportsReasoningLevelOverride) return handler;

  const level = platform().globalState.get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
    {},
  )[handler.config.name];
  const effort = level ? LEVEL_TO_EFFORT[level] : undefined;
  if (effort === undefined) return handler;

  log.debug(
    `Applying reasoning level override for ${handler.config.name}: ${level}`,
  );
  handler.capabilities.reasoningEffort = effort;
  return handler;
}

/**
 * Whether a model is pinned to the Interactions API. `requiresInteractionsAPI`
 * is a future per-model opt-in (parallel to `requiresResponsesAPI`); it is not
 * yet on the external llm-zoo ModelConfig, so read it defensively. v0 registers
 * no model with it set.
 */
function modelRequiresInteractionsAPI(config: ModelConfig): boolean {
  return (
    config.provider === ModelProvider.GOOGLE &&
    !config.openRouterOnly &&
    (config as { requiresInteractionsAPI?: boolean })
      .requiresInteractionsAPI === true
  );
}

/**
 * Fail loudly when an Interactions-only model resolves to OpenRouter —
 * OpenRouter cannot proxy Interactions, so silently routing it through the
 * OpenRouter handler would be wrong (spec §6.3). Called from
 * `createModelHandler` only (the live-routing path that actually instantiates a
 * handler), keeping the routing predicate pure.
 */
function assertGoogleInteractionsRoutable(config: ModelConfig): void {
  if (modelRequiresInteractionsAPI(config)) {
    throw new Error(
      `Model ${config.name} requires the Google Interactions API, which cannot be used through OpenRouter. Disable OpenRouter or select a different model.`,
    );
  }
}

/** Check if OpenAI Responses API should be used for this config. */
export function shouldUseResponsesAPI(
  config: ModelConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.provider !== ModelProvider.OPENAI || config.openRouterOnly) {
    return false;
  }
  if (config.requiresResponsesAPI) return true;

  // Everything below only applies when we are talking to OpenAI directly.
  // OpenRouter proxies these models on /v1/chat/completions and rejects
  // Responses-shaped payloads.
  if (useOpenRouter) return false;

  const { capabilities } = config;
  return (
    (isGpt5ModelName(config.fullName) &&
      capabilities.supportsReasoningEffort !== false &&
      capabilities.supportsFunctionCalling !== false) ||
    config.fullName.startsWith('gpt-oss') ||
    (capabilities.supportsFunctionCalling !== false &&
      getConfig<boolean>(
        'texra.model.useOpenAIResponsesAPI',
        DEFAULT_CORE_SETTINGS.model.useOpenAIResponsesAPI,
      ))
  );
}

/**
 * Single owner for the "prefer short model names" preference read. Read live
 * (no caching) so a mid-session settings change is honored on the next handler
 * creation, matching the other `globalState` reads in this module.
 */
function getPreferShortModelNames(): boolean {
  return platform().globalState.get<boolean>(
    GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    false,
  );
}

function applyShortModelNamePreference(
  config: ModelConfig,
  preferShortModelNames: boolean,
): ModelConfig {
  if (!preferShortModelNames) return config;
  // Mode-selected registry entries share another entry's wire id. Their
  // display-oriented shortName is not an API model identifier.
  if (config.capabilities.reasoningMode !== undefined) return config;
  const short = config.shortName;
  if (!short || short === config.fullName) return config;
  return { ...config, fullName: short };
}

/** Returns the conversation-history format used by the handler for this model. */
export function resolveModelHandlerCompatibilityKey(
  originalConfig: ModelConfig,
  useOpenRouter = getUseOpenRouter(),
  preferShortModelNames = getPreferShortModelNames(),
  copilotRouteOverride?: CopilotRouteOverride,
): ModelHandlerCompatibilityKey | undefined {
  if (shouldUseInternalValidationModelHandler()) {
    return 'ModelHandlerValidation';
  }

  // Editor-supplied models cannot be proxied through OpenRouter. Both Copilot
  // routes — the per-model route preference on a canonical base model, and a
  // config whose provider is Copilot itself — must win before the global
  // OpenRouter preference below. A preference is a hard route choice: when
  // the editor cannot serve it right now, report the route state instead of
  // silently consuming a provider key or subscription (#9635).
  if (
    copilotRouteOverride !== 'direct' &&
    prefersCopilotRoute(originalConfig.name)
  ) {
    const unavailableReason = copilotRouteUnavailableReason(
      originalConfig.name,
    );
    if (unavailableReason) throw new AgentError(unavailableReason);
    return 'ModelHandlerVscodeLm';
  }
  if (originalConfig.provider === ModelProvider.COPILOT) {
    return 'ModelHandlerVscodeLm';
  }

  const config = applyShortModelNamePreference(
    originalConfig,
    preferShortModelNames,
  );
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    return 'ModelHandlerOpenAIResponse';
  }
  if (shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
    return 'ModelHandlerOpenRouterNative';
  }
  return providerHandlerRoute(config.provider)?.compatibilityKey;
}

/**
 * Guarded route-table read. The table is exhaustive over `ModelProvider`, so a
 * miss means a provider string from outside the enum (stale registry entry or
 * persisted config). Report it here instead of crashing on the property
 * access; both callers turn the missing route into a named failure — the model
 * switch reports it as a reason, handler creation throws it.
 */
function providerHandlerRoute(
  provider: ModelProvider,
): ProviderHandlerRoute | undefined {
  const route = PROVIDER_HANDLER_ROUTES[provider];
  if (!route) {
    log.warn(`No model handler route is registered for provider ${provider}`);
    return undefined;
  }
  return route;
}

export function activeModelHandlerCompatibilityKey(
  handler: object,
): ModelHandlerCompatibilityKey | undefined {
  return (handler as ModelHandlerCompatibilityTagged)[
    MODEL_HANDLER_COMPATIBILITY_PROPERTY
  ];
}

/** Compare persisted format keys, falling back to class identity for untagged handlers. */
export function modelHandlersShareConversationFormat(
  first: object,
  second: object,
): boolean {
  const firstKey = activeModelHandlerCompatibilityKey(first);
  const secondKey = activeModelHandlerCompatibilityKey(second);
  return firstKey !== undefined && secondKey !== undefined
    ? firstKey === secondKey
    : first.constructor === second.constructor;
}

function withModelHandlerCompatibilityKey<T extends ModelHandler>(
  handler: T,
  compatibilityKey: ModelHandlerCompatibilityKey,
): T {
  Object.defineProperty(handler, MODEL_HANDLER_COMPATIBILITY_PROPERTY, {
    value: compatibilityKey,
    enumerable: false,
  });
  return handler;
}

/**
 * Apply the user's reasoning-level override and tag the handler with its
 * history-format compatibility key — the shared finishing step for every live
 * provider handler. (The validation handler is deterministic and skips the
 * reasoning override, so it tags directly with
 * {@link withModelHandlerCompatibilityKey}.)
 */
function finalizeModelHandler<T extends ModelHandler>(
  handler: T,
  compatibilityKey: ModelHandlerCompatibilityKey,
): T {
  return withModelHandlerCompatibilityKey(
    withReasoningOverride(handler),
    compatibilityKey,
  );
}

/**
 * Apply the user's "prefer short model names" setting.
 * When enabled, uses the model's shortName (e.g. "gpt-5.5") instead of the
 * date-pinned fullName (e.g. "gpt-5.5-2026-04-15"). Useful for proxies/gateways
 * that only accept unpinned model identifiers.
 */
function withShortModelName(config: ModelConfig): ModelConfig {
  const resolved = applyShortModelNamePreference(
    config,
    getPreferShortModelNames(),
  );
  if (resolved === config) return config;

  log.debug(
    `Using short model name for ${config.name}: ${config.fullName} → ${resolved.fullName}`,
  );
  return resolved;
}

function withCompatibilityRoutingMode(
  config: ModelConfig,
  compatibilityKey: ModelHandlerCompatibilityKey,
): ModelConfig {
  if (compatibilityKey === 'ModelHandlerOpenRouterNative') {
    return { ...config, openRouterOnly: true };
  }

  const routed: ResolvedModelConfig = {
    ...config,
    openRouterOnly: false,
    forceDirectProvider: true,
  };
  return routed;
}

/**
 * Creates a model handler instance based on provider and routing configuration.
 * Applies short model name preference and reasoning level overrides.
 *
 * The ordered routing precedence is owned solely by
 * {@link resolveModelHandlerCompatibilityKey}; this live path computes that key and
 * `switch`es on it for instantiation, so the two can never drift on the key
 * they produce. The only routing decision made here is the async
 * Codex-subscription override, which the pure key predicate deliberately omits
 * because it is key-neutral (same `ModelHandlerOpenAIResponse` key, different
 * handler + backend model id).
 */
export async function createModelHandler(
  originalConfig: ModelConfig,
  responseTextProcessing?: ResponseTextProcessing,
  copilotRouteOverride?: CopilotRouteOverride,
): Promise<ModelHandler> {
  const config = withShortModelName(originalConfig);
  const useOpenRouter = getUseOpenRouter();
  const compatibilityKey = resolveModelHandlerCompatibilityKey(
    config,
    useOpenRouter,
    // Short-name preference was already applied by withShortModelName above;
    // pass false so the key predicate routes on the same resolved config
    // instead of re-resolving it.
    false,
    copilotRouteOverride,
  );
  if (compatibilityKey === 'ModelHandlerOpenRouterNative') {
    assertGoogleInteractionsRoutable(config);
  }

  return createModelHandlerForResolvedCompatibilityKey(
    config,
    compatibilityKey,
    useOpenRouter,
    { allowCodexSubscriptionOverride: true },
    responseTextProcessing,
  );
}

/**
 * Rebuild a handler for an already-persisted conversation format. This is used
 * by resume paths: a snapshot may have been written before a routing default
 * changed, so the transcript format must win over today's default route.
 */
export async function createModelHandlerForCompatibilityKey(
  originalConfig: ModelConfig,
  compatibilityKey: ModelHandlerCompatibilityKey,
  responseTextProcessing?: ResponseTextProcessing,
): Promise<ModelHandler> {
  const routedConfig = withCompatibilityRoutingMode(
    withShortModelName(originalConfig),
    compatibilityKey,
  );
  const useOpenRouter = compatibilityKey === 'ModelHandlerOpenRouterNative';
  return createModelHandlerForResolvedCompatibilityKey(
    routedConfig,
    compatibilityKey,
    useOpenRouter,
    {
      allowCodexSubscriptionOverride:
        compatibilityKey === 'ModelHandlerOpenAIResponse',
    },
    responseTextProcessing,
  );
}

/**
 * ChatGPT subscription (Codex backend via the user's OAuth session) — an
 * async, key-neutral override of the Responses path: these are OpenAI
 * Responses-shaped models the user has opted to drive through their
 * subscription instead of an API key. Gated on the key not being the
 * validation override so the package-validation gate still wins, and not
 * being the Copilot route: a "Via Copilot" row must not silently dispatch
 * through ChatGPT (#9635). Returns a ready handler, or undefined when the
 * subscription route does not apply.
 */
async function tryCodexSubscriptionRoute(
  config: ModelConfig,
  compatibilityKey: ModelHandlerCompatibilityKey | undefined,
  useOpenRouter: boolean,
  allowCodexSubscriptionOverride: boolean,
  responseTextProcessing?: ResponseTextProcessing,
): Promise<ModelHandler | undefined> {
  const codexSubscriptionEligible =
    allowCodexSubscriptionOverride &&
    compatibilityKey !== 'ModelHandlerValidation' &&
    compatibilityKey !== 'ModelHandlerVscodeLm' &&
    resolveCodexSubscriptionCapabilities(config, useOpenRouter) !== null;
  if (!codexSubscriptionEligible) {
    return undefined;
  }

  let codexSessionRoutable: boolean;
  try {
    codexSessionRoutable = await isCodexSessionRoutable();
  } catch (error) {
    if (error instanceof CodexAuthError) {
      throw new AgentError(formatCodexAuthUnavailableMessage(error), {
        cause: error,
      });
    }
    throw error;
  }

  if (!codexSessionRoutable) {
    return undefined;
  }
  log.debug('Using ChatGPT subscription (Codex) Handler');
  const { ModelHandlerCodex } =
    await import('@agent/modelHandlers/openai/modelHandlerCodex');
  return finalizeModelHandler(
    new ModelHandlerCodex(config, responseTextProcessing),
    'ModelHandlerOpenAIResponse',
  );
}

/**
 * Kimi Code (Moonshot coding subscription via a console API key) — a
 * key-neutral override of the Kimi chat-completions path. The conversation
 * format is unchanged, so the persisted compatibility key stays
 * 'ModelHandlerKimi' and resume paths are unaffected; only the request's
 * backend model id, base URL, and credential change. Exclusive plan aliases
 * already carry the pinned coding baseUrl (the registry-fact predicates route
 * their key and endpoint automatically), so they keep `config` untouched.
 * Dual-backend `kimi3` is rerouted only while the "Prefer Kimi Code" switch
 * is on, a key is stored, and the relay is not actually serving requests —
 * under included (relay) access the relay owns eligible models, and the
 * rerouted config's pinned coding `baseUrl` would outrank the relay URL
 * while the credential layer still resolves a relay token (see
 * resolveClientCredential). The reroute swaps in a synthesized runtime
 * config that the normal ModelHandlerKimi switch below then builds.
 *
 * On the resume path `useOpenRouter` is derived from the compatibility key
 * (false unless it's `ModelHandlerOpenRouterNative`), not the live global
 * toggle — and that is correct here: `kimi3` carries an `openrouterFullName`,
 * so an OpenRouter-routed session persists as `ModelHandlerOpenRouterNative`,
 * never `ModelHandlerKimi`. Reaching this branch therefore means the session
 * was a *direct* Kimi session, for which OpenRouter is irrelevant; honoring
 * the current Prefer-Kimi-Code + key on resume keeps a Kimi-Code-only user's
 * resumed sessions runnable when the relay cannot serve them (signed out or
 * included access off — they have no Moonshot key to fall back to).
 *
 * The relay only owns the model when included access is on AND the account
 * can actually use it — a signed-out user with the default-on toggle must
 * still reach their Kimi Code key, matching picker availability. Shared
 * fact assembly + post-route config synthesis live with the route resolver
 * so dispatch and availability cannot drift. Returns the resolved config
 * (unchanged when the route does not apply).
 */
async function applyKimiCodeRoute(
  config: ModelConfig,
  compatibilityKey: ModelHandlerCompatibilityKey | undefined,
  useOpenRouter: boolean,
): Promise<ModelConfig> {
  if (
    compatibilityKey !== 'ModelHandlerKimi' ||
    !isKimiSubscriptionEligible(config)
  ) {
    return config;
  }
  return kimiCodeEffectiveConfig(
    config,
    await resolveKimiCodeRoutingFacts(useOpenRouter),
  );
}

async function createModelHandlerForResolvedCompatibilityKey(
  config: ModelConfig,
  compatibilityKey: ModelHandlerCompatibilityKey | undefined,
  useOpenRouter: boolean,
  options: {
    allowCodexSubscriptionOverride: boolean;
  },
  responseTextProcessing?: ResponseTextProcessing,
): Promise<ModelHandler> {
  if (
    compatibilityKey !== 'ModelHandlerValidation' &&
    isOpenRouterRoutingUnsupported(config, useOpenRouter)
  ) {
    throw new Error(
      `Model ${config.name} requires reasoning mode ${config.capabilities.reasoningMode}, which OpenRouter does not support. Disable OpenRouter and use the provider API directly.`,
    );
  }

  // Key-neutral subscription overrides short-circuit before the per-key switch
  // below: Codex returns a ready handler, Kimi rewrites `config` so the
  // `ModelHandlerKimi` case builds the subscription-backed request.
  const codexHandler = await tryCodexSubscriptionRoute(
    config,
    compatibilityKey,
    useOpenRouter,
    options.allowCodexSubscriptionOverride,
    responseTextProcessing,
  );
  if (codexHandler) {
    return codexHandler;
  }
  config = await applyKimiCodeRoute(config, compatibilityKey, useOpenRouter);

  if (
    compatibilityKey === 'ModelHandlerVscodeLm' &&
    !platform().languageModel.isAvailable()
  ) {
    throw new LanguageModelPortError(
      LANGUAGE_MODEL_PORT_ERROR_CODE.HOST_UNAVAILABLE,
      'The VS Code Language Model API is unavailable in this host. Copilot models require a compatible VS Code extension host.',
    );
  }

  switch (compatibilityKey) {
    case 'ModelHandlerValidation': {
      // Package validation still enters the real CLI and executeAgent path.
      // Only the provider boundary is deterministic, so this must not become
      // a user-facing model selector or an injected command-layer substitute.
      log.warn(
        `${internalValidationModelHandlerEnvName()}=1 is replacing provider handlers with the internal validation handler.`,
      );
      const { ModelHandlerValidation } =
        await import('@agent/modelHandlers/modelHandlerValidation');
      return withModelHandlerCompatibilityKey(
        new ModelHandlerValidation(config, responseTextProcessing),
        'ModelHandlerValidation',
      );
    }

    case 'ModelHandlerOpenAIResponse': {
      log.debug('Using OpenAI Responses API Handler');
      const { ModelHandlerOpenAIResponse } =
        await import('@agent/modelHandlers/openai/modelHandlerOpenAIResponse');
      return finalizeModelHandler(
        new ModelHandlerOpenAIResponse(config, responseTextProcessing),
        'ModelHandlerOpenAIResponse',
      );
    }

    case 'ModelHandlerOpenRouterNative': {
      const openrouterFullName =
        config.openrouterFullName ?? `${config.provider}/${config.fullName}`;
      const { ModelHandlerOpenRouterNative } =
        await import('@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative');
      return finalizeModelHandler(
        new ModelHandlerOpenRouterNative(
          { ...config, openrouterFullName },
          responseTextProcessing,
        ),
        'ModelHandlerOpenRouterNative',
      );
    }

    case 'ModelHandlerVscodeLm': {
      // Explicit case: under canonical model identity (#9635) the config's
      // provider is the base model's own provider, so the default branch's
      // provider route table can no longer reach this handler. A discovered
      // route carries the editor's own context ceiling, and the subscription
      // route is zero-cost per call — apply both to the config the handler
      // validates and accounts against.
      const route = copilotRouteForModel(config.name);
      const routedConfig = route?.effectiveConfig ?? config;
      const { ModelHandlerVscodeLm } =
        await import('@agent/modelHandlers/vscodelm/modelHandlerVscodeLm');
      return finalizeModelHandler(
        new ModelHandlerVscodeLm(routedConfig, responseTextProcessing),
        'ModelHandlerVscodeLm',
      );
    }

    default: {
      // Direct provider handler. The key is the provider's registered route key.
      const route = providerHandlerRoute(config.provider);
      if (!route) {
        throw new Error(`Unsupported model provider: ${config.provider}`);
      }
      const HandlerClass = await route.load();
      log.debug(`Using Handler: ${HandlerClass.name}`);
      return finalizeModelHandler(
        new HandlerClass(config, responseTextProcessing),
        route.compatibilityKey,
      );
    }
  }
}
