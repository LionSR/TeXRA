import { isApiProvider, type ApiProvider } from './apiProviders';

import type { ModelConfig } from 'llm-zoo';

export interface OpenRouterRoutingConfig {
  provider?: string;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
  forceDirectProvider?: boolean;
  capabilities?: Pick<ModelConfig['capabilities'], 'reasoningMode'>;
}

/** Direct handler families for registry entries served outside their model provider's default API. */
export type DirectModelHandlerProfile = 'anthropic' | 'openai-reasoning';

/** Optional route metadata layered over llm-zoo's provider-family metadata. */
export interface DirectModelRoutingConfig {
  readonly directAccess?: {
    readonly source: string;
    readonly credential: ApiProvider;
    readonly baseUrl: string;
    readonly handlerProfile: DirectModelHandlerProfile;
    readonly allowOpenRouter: boolean;
    readonly allowRelay: boolean;
  };
}

export type ModelRoutingConfig = OpenRouterRoutingConfig &
  DirectModelRoutingConfig;

function isOpenRouterAccessSelected(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  return (
    config.directAccess?.allowOpenRouter !== false &&
    !config.forceDirectProvider &&
    (config.openRouterOnly || useOpenRouter)
  );
}

/** Whether the requested OpenRouter route would discard required model semantics. */
export function isOpenRouterRoutingUnsupported(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  return (
    isOpenRouterAccessSelected(config, useOpenRouter) &&
    config.capabilities?.reasoningMode !== undefined
  );
}

/** API-key owner for the route ModelFactory will use for this model. */
export function resolveModelApiKeyProvider(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): ApiProvider | undefined {
  if (shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
    return 'openRouter';
  }
  return resolveDirectModelApiKeyProvider(config);
}

/** API-key owner for the direct route, independent of the global OpenRouter choice. */
export function resolveDirectModelApiKeyProvider(
  config: Pick<ModelRoutingConfig, 'directAccess' | 'provider'>,
): ApiProvider | undefined {
  if (config.directAccess) return config.directAccess.credential;
  return config.provider && isApiProvider(config.provider)
    ? config.provider
    : undefined;
}

/** Product-facing model source; direct managed services own their own group. */
export function resolveModelSource(
  config: Pick<ModelRoutingConfig, 'directAccess' | 'provider'>,
): string | undefined {
  return config.directAccess?.source ?? config.provider;
}

/** Handler profile explicitly selected by a direct managed-service entry. */
export function resolveDirectModelHandlerProfile(
  config: Pick<ModelRoutingConfig, 'directAccess' | 'provider'>,
): DirectModelHandlerProfile | undefined {
  return config.directAccess?.handlerProfile;
}

/** Fixed base URL for a managed direct route. */
export function resolveDirectModelBaseUrl(
  config: Pick<ModelRoutingConfig, 'directAccess' | 'provider'>,
): string | undefined {
  return config.directAccess?.baseUrl;
}

/** Whether a model may be sent through TeXRA's included-access relay. */
export function allowsModelRelay(
  config: Pick<ModelRoutingConfig, 'directAccess' | 'provider'>,
): boolean {
  return config.directAccess?.allowRelay ?? true;
}

/** Return whether this model request should be routed through OpenRouter. */
export function shouldRouteModelThroughOpenRouter(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.requiresResponsesAPI) return false;
  return isOpenRouterAccessSelected(config, useOpenRouter);
}
