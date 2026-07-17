import { isApiProvider, type ApiProvider } from './apiProviders';
import { isKimiCodeExclusiveModel } from './kimiCodeSubscriptionRouting';

import type { ModelConfig } from 'llm-zoo';

interface OpenRouterRoutingConfig {
  provider?: string;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
  forceDirectProvider?: boolean;
  capabilities?: Pick<ModelConfig['capabilities'], 'reasoningMode'>;
}

/**
 * Managed-route facts read straight off the llm-zoo registry entry: a model
 * whose `kimiSubscription` flag pairs with a pinned Kimi Code `baseUrl` is
 * served ONLY by that managed endpoint (see
 * {@link isKimiCodeExclusiveModel}), so its credential and endpoint stay
 * paired and it always bypasses OpenRouter and the included-access relay.
 */
interface ManagedRouteFields {
  kimiSubscription?: boolean;
  baseUrl?: string;
}

export type ModelRoutingConfig = OpenRouterRoutingConfig & ManagedRouteFields;

/** Whether a registry entry owns an atomic managed-service route. */
export function hasManagedDirectRoute(
  config: Pick<ModelRoutingConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): boolean {
  return isKimiCodeExclusiveModel(config);
}

function isOpenRouterAccessSelected(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  return (
    !hasManagedDirectRoute(config) &&
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
  config: Pick<ModelRoutingConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): ApiProvider | undefined {
  if (hasManagedDirectRoute(config)) return 'kimiCode';
  return config.provider && isApiProvider(config.provider)
    ? config.provider
    : undefined;
}

/** Product-facing model source; direct managed services own their own group. */
export function resolveModelSource(
  config: Pick<ModelRoutingConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string | undefined {
  return hasManagedDirectRoute(config) ? 'kimiCode' : config.provider;
}

/** Whether a model may be sent through TeXRA's included-access relay. */
export function allowsModelRelay(
  config: Pick<ModelRoutingConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): boolean {
  return !hasManagedDirectRoute(config);
}

/** Return whether this model request should be routed through OpenRouter. */
export function shouldRouteModelThroughOpenRouter(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.requiresResponsesAPI) return false;
  return isOpenRouterAccessSelected(config, useOpenRouter);
}
