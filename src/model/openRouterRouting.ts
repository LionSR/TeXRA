export interface OpenRouterRoutingConfig {
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
}

/** Return whether this model request should be routed through OpenRouter. */
export function shouldRouteModelThroughOpenRouter(
  config: OpenRouterRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.requiresResponsesAPI) return false;
  return config.openRouterOnly || useOpenRouter;
}
