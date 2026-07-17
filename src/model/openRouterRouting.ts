import { isApiProvider, type ApiProvider } from './apiProviders';

import type { ModelConfig } from 'llm-zoo';

export interface OpenRouterRoutingConfig {
  provider?: string;
  /** Explicit direct-key owner; models with one never route through OpenRouter. */
  apiKeyProvider?: ApiProvider;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
  forceDirectProvider?: boolean;
  capabilities?: Pick<ModelConfig['capabilities'], 'reasoningMode'>;
}

function isOpenRouterAccessSelected(
  config: OpenRouterRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  return (
    !config.apiKeyProvider &&
    !config.forceDirectProvider &&
    (config.openRouterOnly || useOpenRouter)
  );
}

/** Whether the requested OpenRouter route would discard required model semantics. */
export function isOpenRouterRoutingUnsupported(
  config: OpenRouterRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  return (
    isOpenRouterAccessSelected(config, useOpenRouter) &&
    config.capabilities?.reasoningMode !== undefined
  );
}

/** API-key owner for the route ModelFactory will use for this model. */
export function resolveModelApiKeyProvider(
  config: OpenRouterRoutingConfig,
  useOpenRouter: boolean,
): ApiProvider | undefined {
  if (config.apiKeyProvider) {
    return config.apiKeyProvider;
  }
  if (shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
    return 'openRouter';
  }
  return config.provider && isApiProvider(config.provider)
    ? config.provider
    : undefined;
}

/** Return whether this model request should be routed through OpenRouter. */
export function shouldRouteModelThroughOpenRouter(
  config: OpenRouterRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.requiresResponsesAPI) return false;
  return isOpenRouterAccessSelected(config, useOpenRouter);
}
