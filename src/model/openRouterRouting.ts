import { isApiProvider, type ApiProvider } from './apiProviders';
import {
  isKimiCodeExclusiveModel,
  type KimiSubscriptionModelFields,
} from './kimiCodeSubscriptionRouting';

import type { ModelConfig } from 'llm-zoo';

/**
 * A {@link ModelConfig} carrying TeXRA's own runtime-only routing override.
 * `forceDirectProvider` is not part of llm-zoo's registry shape — it is
 * stamped onto a config by `ModelFactory.withCompatibilityRoutingMode` when
 * rebuilding a handler for an already-persisted conversation format that must
 * stay off OpenRouter even if the global OpenRouter toggle is later turned
 * on. This module owns the field's meaning (see `isOpenRouterAccessSelected`
 * below), so it is also the single declaration site: `ModelHandler.config`
 * and every routing helper that reads the field import this type instead of
 * re-declaring it locally.
 */
export type ResolvedModelConfig = ModelConfig & {
  readonly forceDirectProvider?: boolean;
};

interface OpenRouterRoutingConfig {
  provider?: string;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
  forceDirectProvider?: ResolvedModelConfig['forceDirectProvider'];
  capabilities?: Pick<ModelConfig['capabilities'], 'reasoningMode'>;
}

/**
 * Managed-route facts read straight off the llm-zoo registry entry (see
 * {@link KimiSubscriptionModelFields}): a model whose `kimiSubscription` flag
 * pairs with a pinned Kimi Code `baseUrl` is served ONLY by that managed
 * endpoint (see {@link isKimiCodeExclusiveModel}), so its credential and
 * endpoint stay paired and it always bypasses OpenRouter and the
 * included-access relay.
 */
export type ModelRoutingConfig = OpenRouterRoutingConfig &
  KimiSubscriptionModelFields;

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
