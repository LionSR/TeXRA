import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { resolveGlmRoute } from '@model/glmRouting';
import {
  isKimiCodeExclusiveModel,
  type KimiSubscriptionModelFields,
} from '@shared/model/kimiCodeRetryGate';

import { isApiProvider, type ApiProvider } from './apiProviders';

interface OpenRouterRoutingConfig {
  provider?: string;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
  capabilities?: Pick<ModelConfig['capabilities'], 'reasoningMode'>;
}

/**
 * Managed-route facts read straight off the llm-zoo registry entry (see
 * {@link KimiSubscriptionModelFields}): a model whose `kimiSubscription` flag
 * pairs with a pinned Kimi Code `baseUrl` is served ONLY by that managed
 * endpoint (see {@link isKimiCodeExclusiveModel}), so its credential and
 * endpoint stay paired and it always bypasses OpenRouter.
 */
export type ModelRoutingConfig = OpenRouterRoutingConfig &
  KimiSubscriptionModelFields;

function isOpenRouterAccessSelected(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  return (
    !isKimiCodeExclusiveModel(config) &&
    (config.openRouterOnly || useOpenRouter)
  );
}

/** Whether the requested OpenRouter route would discard required model semantics. */
export function isOpenRouterRoutingUnsupported(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  const openRouterSelected =
    config.provider === ModelProvider.GLM
      ? shouldRouteModelThroughOpenRouter(config, useOpenRouter)
      : isOpenRouterAccessSelected(config, useOpenRouter);
  return openRouterSelected && config.capabilities?.reasoningMode !== undefined;
}

/** API-key owner for the route `modelRoutes` will use for this model. */
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
  if (isKimiCodeExclusiveModel(config)) return 'kimiCode';
  return config.provider && isApiProvider(config.provider)
    ? config.provider
    : undefined;
}

/** Product-facing model source; direct managed services own their own group. */
export function resolveModelSource(
  config: Pick<ModelRoutingConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string | undefined {
  return isKimiCodeExclusiveModel(config) ? 'kimiCode' : config.provider;
}

/** Return whether this model request should be routed through OpenRouter. */
export function shouldRouteModelThroughOpenRouter(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.requiresResponsesAPI) return false;
  const openRouterSelected = isOpenRouterAccessSelected(config, useOpenRouter);
  if (config.provider !== ModelProvider.GLM) return openRouterSelected;
  return (
    resolveGlmRoute({
      baseUrl: config.baseUrl,
      useOpenRouter: openRouterSelected,
    }).route === 'openrouter'
  );
}
