import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { shouldUseInternalValidationModel } from '@agent/runtime/run/validationModel';
import { resolveRouteEndpoint } from '@agent/runtime/run/routeEndpoint';
import { AgentError } from '@common/errors';
import { attachMissingApiKeyError } from '@common/errors/sdkError/errorMetadata';
import { createLog } from '@logger/logUtils';
import {
  copilotRouteUnavailableReason,
  prefersCopilotRoute,
  type CopilotRouteOverride,
} from '@model/copilotRouting';
import { isGpt5ModelName } from '@model/modelNames';
import {
  resolveDirectModelApiKeyProvider,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { exposeApiKey, getApiKey, type ApiProvider } from '@model/apiProviders';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { ModelHandlerCompatibilityKey, UsageRoute } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { getConfig } from '@utils/config/configUtils';

const log = createLog('ModelFactory');

// Record (not Map) so TypeScript enforces exhaustiveness over ModelProvider.
// A new enum value in llm-zoo without an entry here will fail typecheck.
const PROVIDER_COMPATIBILITY_KEYS: Record<
  ModelProvider,
  ModelHandlerCompatibilityKey
> = {
  [ModelProvider.ANTHROPIC]: 'ModelHandlerAnthropic',
  [ModelProvider.OPENAI]: 'ModelHandlerOpenAI',
  [ModelProvider.GOOGLE]: 'ModelHandlerGoogleInteractions',
  [ModelProvider.DEEPSEEK]: 'ModelHandlerDeepSeek',
  [ModelProvider.XAI]: 'ModelHandlerXAI',
  [ModelProvider.MOONSHOT]: 'ModelHandlerKimi',
  [ModelProvider.DASHSCOPE]: 'ModelHandlerDashScope',
  [ModelProvider.MINIMAX]: 'ModelHandlerMiniMax',
  [ModelProvider.GLM]: 'ModelHandlerGLM',
  [ModelProvider.META]: 'ModelHandlerMeta',
  [ModelProvider.OTHERS]: 'ModelHandlerOpenRouterNative',
  [ModelProvider.COPILOT]: 'ModelHandlerVscodeLm',
};

/** Check if OpenAI Responses API should be used for this config. */
function shouldUseResponsesAPI(
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
      getConfig<boolean>('texra.model.useOpenAIResponsesAPI'))
  );
}

/**
 * Single owner for the "prefer short model names" preference read. Read live
 * (no caching) so a mid-session settings change is honored on the next handler
 * creation, matching the other `globalState` reads in this module.
 */
function getPreferShortModelNames(globalState: StateStore): boolean {
  return globalState.get<boolean>(
    GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    false,
  );
}

/** The credential and endpoint of one model route, resolved together. */
export interface RouteCredential {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly provider: ApiProvider;
  readonly route: 'api-key' | 'openrouter';
  readonly usageRoute: UsageRoute;
}

/**
 * Resolve the credential and endpoint the run loop binds a model under: the
 * direct API key of the model's provider, or the OpenRouter key when the
 * route goes through OpenRouter. The one producer of the missing-credential
 * fact the run lifecycle classifies for the loop, so the thrown error carries
 * the typed marker rather than a message pattern. Lives beside the route
 * resolver above so route and credential are decided in one place. `secrets`
 * is the process secret store the caller already holds.
 */
export async function resolveRouteCredential(
  config: ModelConfig,
  useOpenRouter: boolean,
  secrets: PlatformSecrets,
): Promise<RouteCredential> {
  const provider = useOpenRouter
    ? 'openRouter'
    : resolveDirectModelApiKeyProvider(config);
  if (!provider) {
    throw new Error(`Model "${config.name}" has no direct API-key provider.`);
  }
  let apiKey: string;
  try {
    apiKey = exposeApiKey(await getApiKey(secrets, provider));
  } catch (cause) {
    const error = new Error(
      useOpenRouter
        ? 'Missing OpenRouter API key. Set an OpenRouter API key in settings.'
        : `Missing API key for ${provider}. Set a provider API key in settings.`,
      { cause },
    );
    attachMissingApiKeyError(error);
    throw error;
  }
  const endpoint = resolveRouteEndpoint(config, useOpenRouter);
  return {
    apiKey,
    endpoint: endpoint.baseUrl,
    provider,
    route: useOpenRouter ? 'openrouter' : 'api-key',
    usageRoute:
      endpoint.usageRoute ??
      (provider === 'kimiCode' ? 'kimi-code-subscription' : 'api-key'),
  };
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
  globalState: StateStore,
  useOpenRouter = getUseOpenRouter(),
  copilotRouteOverride?: CopilotRouteOverride,
): ModelHandlerCompatibilityKey | undefined {
  if (shouldUseInternalValidationModel()) {
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
    prefersCopilotRoute(originalConfig.name, globalState)
  ) {
    const unavailableReason = copilotRouteUnavailableReason(
      originalConfig.name,
      globalState,
    );
    if (unavailableReason) throw new AgentError(unavailableReason);
    return 'ModelHandlerVscodeLm';
  }
  if (originalConfig.provider === ModelProvider.COPILOT) {
    return 'ModelHandlerVscodeLm';
  }

  // Re-application is identity on an already-shortened config, so the live
  // `bindModel` path can hand this its own resolved config.
  const config = applyShortModelNamePreference(
    originalConfig,
    getPreferShortModelNames(globalState),
  );
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    return 'ModelHandlerOpenAIResponse';
  }
  if (shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
    return 'ModelHandlerOpenRouterNative';
  }
  return providerCompatibilityKey(config.provider);
}

/**
 * Guarded route-table read. The table is exhaustive over `ModelProvider`, so a
 * miss means a provider string from outside the enum (stale registry entry or
 * persisted config). Report it here instead of crashing on the property
 * access; the caller turns the missing route into a named failure.
 */
function providerCompatibilityKey(
  provider: ModelProvider,
): ModelHandlerCompatibilityKey | undefined {
  const key = PROVIDER_COMPATIBILITY_KEYS[provider];
  if (!key) {
    log.warn(`No model route is registered for provider ${provider}`);
    return undefined;
  }
  return key;
}
