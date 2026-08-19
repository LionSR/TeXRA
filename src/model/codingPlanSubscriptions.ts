import { ModelProvider } from 'llm-zoo';

import { hasUsableApiKey } from '@model/apiProviders';
import {
  isKimiCodeRoute,
  resolveKimiCodeRoutingFacts,
} from '@model/kimiCodeSubscriptionRouting';
import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';
import { oauthSubscriptionUsageRoute } from '@model/providerCapabilities';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { platform } from '@platform/platform';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@shared/codingPlanSubscriptions';
import type { UsageRoute } from '@shared/schemas';
import { isKimiSubscriptionEligible } from '@shared/model/kimiCodeRetryGate';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  getGLMCodingPlan,
  getProviderEndpoint,
  getPreferKimiCode,
  getUseOpenRouter,
  setGLMCodingPlan,
} from '@utils/config/providerConfig';
import { writePlatformSetting } from '@utils/config/platformSettings';

export interface CodingPlanSubscriptionRuntime {
  readonly descriptor: CodingPlanSubscription;
  readonly getEnabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  /** Restore a captured preference without changing a newer competing route. */
  readonly restoreEnabled: (enabled: boolean) => Promise<void>;
  readonly isActiveForModel: (modelId: string) => Promise<boolean>;
}

async function isGlmCodingPlanActive(modelId: string): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (
    config?.provider !== ModelProvider.GLM ||
    !getGLMCodingPlan() ||
    shouldRouteModelThroughOpenRouter(config, getUseOpenRouter()) ||
    config.baseUrl != null ||
    getProviderEndpoint('glm') !== ''
  ) {
    return false;
  }
  return hasUsableApiKey(platform().secrets, 'glm');
}

/**
 * Whether the model currently routes through the Kimi Code coding endpoint
 * (Moonshot coding subscription, authenticated by the Kimi Code API key).
 * Mirrors ModelFactory's dispatch facts: registry eligibility, the OpenRouter
 * toggle, a stored key, and the "Prefer Kimi Code" switch.
 */
async function isKimiCodeSubscriptionActive(modelId: string): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config || !isKimiSubscriptionEligible(config)) return false;
  return isKimiCodeRoute(
    config,
    await resolveKimiCodeRoutingFacts(getUseOpenRouter()),
  );
}

const RUNTIME_BY_ID = {
  glmCodingPlan: {
    getEnabled: getGLMCodingPlan,
    setEnabled: setGLMCodingPlan,
    restoreEnabled: setGLMCodingPlan,
    isActiveForModel: isGlmCodingPlanActive,
  },
  kimiCode: {
    getEnabled: getPreferKimiCode,
    setEnabled: (enabled) =>
      writePlatformSetting(GlobalStateKey.KIMI_CODE_PREFER, enabled),
    // Restore writes the stored value directly: the catalog row's OpenRouter
    // exclusion is a *user intent* rule, and re-applying it here would clear a
    // newer competing route the user chose after the capture.
    restoreEnabled: async (enabled) => {
      await platform().globalState.update(
        GlobalStateKey.KIMI_CODE_PREFER,
        enabled,
      );
    },
    isActiveForModel: isKimiCodeSubscriptionActive,
  },
} as const satisfies Record<
  CodingPlanSubscription['id'],
  Omit<CodingPlanSubscriptionRuntime, 'descriptor'>
>;

/** Runtime catalog consumed by retry policy and host route presentation. */
export const codingPlanSubscriptionRuntimes = Object.freeze(
  CODING_PLAN_SUBSCRIPTIONS.map((descriptor) =>
    Object.freeze({
      descriptor,
      ...RUNTIME_BY_ID[descriptor.id],
    }),
  ),
);

/** Resolve the coding plan currently serving a model, if any. */
export async function activeCodingPlanForModel(
  modelId: string,
): Promise<CodingPlanSubscriptionRuntime | undefined> {
  const active = await Promise.all(
    codingPlanSubscriptionRuntimes.map(async (runtime) => ({
      runtime,
      active: await runtime.isActiveForModel(modelId),
    })),
  );
  return active.find((candidate) => candidate.active)?.runtime;
}

/**
 * The subscription route that would serve this model's next request, or
 * undefined when it would be paid for with the user's own API key.
 *
 * Single owner of "which subscription serves this model next": the OAuth
 * subscriptions answer from their capability profile's `usageRoute`, the
 * coding plans from their catalog descriptor. Callers get a `UsageRoute` — the
 * same vocabulary completed usage is stamped with — so no surface has to
 * re-order per-provider booleans to reach the same answer. At most one arm can
 * resolve: each subscription requires its own `config.provider`.
 *
 * Lives here rather than in `@model/providerCapabilities` so the OAuth-only
 * module stays free of the coding-plan runtime, which reads stored keys.
 */
export async function activeSubscriptionUsageRoute(
  modelId: string,
): Promise<UsageRoute | undefined> {
  return (
    (await oauthSubscriptionUsageRoute(modelId)) ??
    (await activeCodingPlanForModel(modelId))?.descriptor.usageRoute
  );
}
