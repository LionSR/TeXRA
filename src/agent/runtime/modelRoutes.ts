import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { shouldUseInternalValidationModel } from '@agent/runtime/run/validationModel';
import { resolveRouteEndpoint } from '@agent/runtime/run/routeEndpoint';
import {
  CODEX_BACKEND_BASE_URL,
  CodexAuthError,
  codexCoordinator,
  formatCodexAuthUnavailableMessage,
  isCodexSessionRoutable,
} from '@auth/codex';
import {
  XaiAuthError,
  formatXaiAuthUnavailableMessage,
  xaiCoordinator,
} from '@auth/xai';
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
  codexBackendModelId,
  resolveCodexSubscriptionCapabilities,
  resolveXaiSubscriptionCapabilities,
} from '@model/providerCapabilities';
import { isXaiSignedIn } from '@model/xai/xaiSignedIn';
import {
  resolveDirectModelApiKeyProvider,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { exposeApiKey, getApiKey, type ApiProvider } from '@model/apiProviders';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { ModelCompatibilityKey, UsageRoute } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { getConfig } from '@utils/config/configUtils';

const log = createLog('modelRoutes');

/**
 * The Grok subscription's OAuth token is accepted by xAI's own API surface
 * only; it is never sent to a dashboard custom endpoint or OpenRouter.
 */
const XAI_SUBSCRIPTION_ENDPOINT = 'https://api.x.ai/v1';

// Record (not Map) so TypeScript enforces exhaustiveness over ModelProvider.
// A new enum value in llm-zoo without an entry here will fail typecheck.
const PROVIDER_COMPATIBILITY_KEYS: Record<
  ModelProvider,
  ModelCompatibilityKey
> = {
  [ModelProvider.ANTHROPIC]: 'Anthropic',
  [ModelProvider.OPENAI]: 'OpenAI',
  [ModelProvider.GOOGLE]: 'GoogleInteractions',
  [ModelProvider.DEEPSEEK]: 'DeepSeek',
  [ModelProvider.XAI]: 'XAI',
  [ModelProvider.MOONSHOT]: 'Kimi',
  [ModelProvider.DASHSCOPE]: 'DashScope',
  [ModelProvider.MINIMAX]: 'MiniMax',
  [ModelProvider.GLM]: 'GLM',
  [ModelProvider.META]: 'Meta',
  [ModelProvider.OTHERS]: 'OpenRouterNative',
  [ModelProvider.COPILOT]: 'VscodeLm',
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
 * (no caching) so a mid-session settings change is honored on the next
 * binding, matching the other `globalState` reads in this module.
 */
function getPreferShortModelNames(globalState: StateStore): boolean {
  return globalState.get<boolean>(
    GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    false,
  );
}

/** The API-key credential and endpoint of one model route, resolved together. */
export interface ApiKeyRouteCredential {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly provider: ApiProvider;
  readonly route: 'api-key' | 'openrouter';
  readonly usageRoute: UsageRoute;
}

/**
 * An OAuth subscription session standing in for the provider's API key: the
 * ChatGPT (Codex) session on the Responses protocol, the Grok session on the
 * xAI Chat protocol. The token is the bearer the package sends; `@auth/*`
 * owns its refresh, so a binding always carries a fresh one.
 */
export type SubscriptionRouteCredential =
  | {
      readonly route: 'chatgpt-subscription';
      readonly accessToken: string;
      readonly accountId: string | null;
      /** The Codex backend's bare model id, which differs from the API's. */
      readonly requestedModel: string;
      readonly endpoint: string;
      readonly provider: ApiProvider;
      readonly usageRoute: 'chatgpt-subscription';
    }
  | {
      readonly route: 'xai-subscription';
      readonly accessToken: string;
      readonly endpoint: string;
      readonly provider: ApiProvider;
      readonly usageRoute: 'xai-subscription';
    };

export type RouteCredential =
  ApiKeyRouteCredential | SubscriptionRouteCredential;

/** The bearer secret of a route, whichever credential kind carries it. */
export function routeBearer(credential: RouteCredential): string {
  switch (credential.route) {
    case 'api-key':
    case 'openrouter':
      return credential.apiKey;
    case 'chatgpt-subscription':
    case 'xai-subscription':
      return credential.accessToken;
  }
}

/**
 * The subscription route a model binds under, if the user prefers one, the
 * model is eligible on it, and a session is signed in. Decided above
 * {@link resolveRouteCredential}: an eligible model with the preference on
 * but no routable session falls back to the API key, and says so, because
 * the preference is a preference (the model list already shows which route
 * serves the model), while a signed-in session that fails to refresh is a
 * failure and surfaces as one. The returned config is the route's own: the
 * subscription's context ceiling and its zero per-token price.
 */
export async function resolveSubscriptionCredential(
  config: ModelConfig,
  useOpenRouter: boolean,
): Promise<{
  readonly credential: SubscriptionRouteCredential;
  readonly config: ModelConfig;
} | null> {
  const provider = resolveDirectModelApiKeyProvider(config);
  if (provider === undefined) return null;
  if (config.provider === ModelProvider.OPENAI) {
    const profile = resolveCodexSubscriptionCapabilities(config, useOpenRouter);
    if (profile === null) return null;
    let routable: boolean;
    try {
      routable = await isCodexSessionRoutable();
    } catch (error) {
      throw error instanceof CodexAuthError
        ? new AgentError(formatCodexAuthUnavailableMessage(error), {
            cause: error,
          })
        : error;
    }
    if (!routable) {
      log.warn(
        `Prefer ChatGPT subscription is on but no ChatGPT session is signed in: model ${config.name} bills the OpenAI API key.`,
      );
      return null;
    }
    const coordinator = codexCoordinator();
    return {
      credential: {
        route: 'chatgpt-subscription',
        accessToken: await coordinator.getFreshAccessToken(),
        accountId: (await coordinator.getAccountId()) ?? null,
        requestedModel: codexBackendModelId(config),
        endpoint: CODEX_BACKEND_BASE_URL,
        provider,
        usageRoute: 'chatgpt-subscription',
      },
      config: {
        ...config,
        contextWindow: profile.contextWindow,
        inputPrice: profile.inputPrice,
        outputPrice: profile.outputPrice,
      },
    };
  }
  if (config.provider === ModelProvider.XAI) {
    const profile = resolveXaiSubscriptionCapabilities(config, useOpenRouter);
    if (profile === null) return null;
    if (!(await isXaiSignedIn())) {
      log.warn(
        `Prefer Grok subscription is on but no Grok session is signed in: model ${config.name} bills the xAI API key.`,
      );
      return null;
    }
    let accessToken: string;
    try {
      accessToken = await xaiCoordinator().getFreshAccessToken();
    } catch (error) {
      throw error instanceof XaiAuthError
        ? new AgentError(formatXaiAuthUnavailableMessage(error), {
            cause: error,
          })
        : error;
    }
    return {
      credential: {
        route: 'xai-subscription',
        accessToken,
        endpoint: XAI_SUBSCRIPTION_ENDPOINT,
        provider,
        usageRoute: 'xai-subscription',
      },
      config: {
        ...config,
        contextWindow: profile.contextWindow,
        inputPrice: profile.inputPrice,
        outputPrice: profile.outputPrice,
      },
    };
  }
  return null;
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
): Promise<ApiKeyRouteCredential> {
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

/** Returns the conversation-history format this model binds under. */
export function resolveModelCompatibilityKey(
  originalConfig: ModelConfig,
  globalState: StateStore,
  useOpenRouter = getUseOpenRouter(),
  copilotRouteOverride?: CopilotRouteOverride,
): ModelCompatibilityKey | undefined {
  if (shouldUseInternalValidationModel()) {
    return 'Validation';
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
    return 'VscodeLm';
  }
  if (originalConfig.provider === ModelProvider.COPILOT) {
    return 'VscodeLm';
  }

  // Re-application is identity on an already-shortened config, so the live
  // `bindModel` path can hand this its own resolved config.
  const config = applyShortModelNamePreference(
    originalConfig,
    getPreferShortModelNames(globalState),
  );
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    return 'OpenAIResponse';
  }
  if (shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
    return 'OpenRouterNative';
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
): ModelCompatibilityKey | undefined {
  const key = PROVIDER_COMPATIBILITY_KEYS[provider];
  if (!key) {
    log.warn(`No model route is registered for provider ${provider}`);
    return undefined;
  }
  return key;
}
