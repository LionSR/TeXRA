import { ModelProvider } from 'llm-zoo';

import { apiKeyExists } from '@model/apiProviders';
import { includedModelAccess } from '@model/includedModelAccess';
import {
  shouldRouteModelThroughOpenRouter,
  type ModelRoutingConfig,
} from '@model/openRouterRouting';
import { isKimiCodeSubscriptionActive } from '@model/providerCapabilities';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { platform } from '@platform/platform';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@shared/codingPlanSubscriptions';
import {
  getGLMCodingPlan,
  getProviderEndpoint,
  getPreferKimiCode,
  getUseOpenRouter,
  setGLMCodingPlan,
  setPreferKimiCode,
} from '@utils/config/providerConfig';

export interface CodingPlanSubscriptionRuntime {
  readonly descriptor: CodingPlanSubscription;
  readonly getEnabled: () => boolean;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  /** Restore a captured preference without changing a newer competing route. */
  readonly restoreEnabled: (enabled: boolean) => Promise<void>;
  readonly isActiveForModel: (modelId: string) => Promise<boolean>;
}

/** Whether GLM requests use the coding-plan endpoint rather than another route. */
export function isGlmCodingPlanRouteActive(
  config: ModelRoutingConfig,
): boolean {
  return (
    getGLMCodingPlan() &&
    !shouldRouteModelThroughOpenRouter(config, getUseOpenRouter()) &&
    config.baseUrl == null &&
    getProviderEndpoint('glm') === ''
  );
}

async function isGlmCodingPlanActive(modelId: string): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (
    config?.provider !== ModelProvider.GLM ||
    !isGlmCodingPlanRouteActive(config)
  ) {
    return false;
  }
  const includedAccess = includedModelAccess();
  await includedAccess.canUseServerSideKeys();
  if (
    includedAccess.shouldUseServerSideKeysSync(config.provider, config.name)
  ) {
    return false;
  }
  return apiKeyExists(platform().secrets, 'glm');
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
    setEnabled: setPreferKimiCode,
    restoreEnabled: (enabled) =>
      setPreferKimiCode(enabled, undefined, { preserveOpenRouter: true }),
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
