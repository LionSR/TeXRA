import { isApiProvider, type ApiProvider } from './apiProviders';

export interface OpenRouterRoutingConfig {
  provider?: string;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
  forceDirectProvider?: boolean;
}

/** API-key owner for the route ModelFactory will use for this model. */
export function resolveModelApiKeyProvider(
  config: OpenRouterRoutingConfig,
  useOpenRouter: boolean,
): ApiProvider | undefined {
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
  if (config.forceDirectProvider) return false;
  if (config.requiresResponsesAPI) return false;
  return config.openRouterOnly || useOpenRouter;
}
