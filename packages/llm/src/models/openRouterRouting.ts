import { ModelProvider, type ModelConfig, type ReasoningMode } from 'llm-zoo';

import {
  isKimiCodeExclusiveModel,
  type KimiSubscriptionModelFields,
} from './kimiCodeRetryGate.js';

interface OpenRouterRoutingConfig {
  provider?: string;
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
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

/**
 * Whether the requested OpenRouter route would discard what the request asks
 * for: OpenRouter has no provider reasoning modes (OpenAI's `pro`).
 */
export function isOpenRouterRoutingUnsupported(
  config: ModelRoutingConfig,
  useOpenRouter: boolean,
  mode: ReasoningMode | undefined,
): boolean {
  const openRouterSelected =
    config.provider === ModelProvider.GLM
      ? shouldRouteModelThroughOpenRouter(config, useOpenRouter)
      : isOpenRouterAccessSelected(config, useOpenRouter);
  return openRouterSelected && mode !== undefined;
}

/** Product-facing model source; direct managed services own their own group. */
export function resolveModelSource(
  config: Pick<ModelConfig, 'provider' | 'kimiSubscription' | 'baseUrl'>,
): string {
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
  // A per-model base URL outranks OpenRouter (`./routeEndpoint.ts`).
  return !config.baseUrl && openRouterSelected;
}
