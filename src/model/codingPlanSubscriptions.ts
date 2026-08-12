import { ModelProvider } from 'llm-zoo';

import { apiKeyExists } from '@model/apiProviders';
import {
  isKimiCodeRoute,
  isKimiSubscriptionEligible,
  resolveKimiCodeRoutingFacts,
} from '@model/kimiCodeSubscriptionRouting';
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
  readonly isActiveForModel: (modelId: string) => Promise<boolean>;
}

async function isGlmCodingPlanActive(modelId: string): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (
    config?.provider !== ModelProvider.GLM ||
    getUseOpenRouter() ||
    config.baseUrl != null ||
    getProviderEndpoint('glm') !== '' ||
    !getGLMCodingPlan()
  ) {
    return false;
  }
  return apiKeyExists(platform().secrets, 'glm');
}

async function isKimiCodingPlanActive(modelId: string): Promise<boolean> {
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
    isActiveForModel: isGlmCodingPlanActive,
  },
  kimiCode: {
    getEnabled: getPreferKimiCode,
    setEnabled: setPreferKimiCode,
    isActiveForModel: isKimiCodingPlanActive,
  },
} as const satisfies Record<
  CodingPlanSubscription['id'],
  Omit<CodingPlanSubscriptionRuntime, 'descriptor'>
>;

/** Runtime catalog consumed by retry policy and host route presentation. */
export const codingPlanSubscriptionRuntimes = Object.freeze(
  CODING_PLAN_SUBSCRIPTIONS.map((descriptor) => ({
    descriptor,
    ...RUNTIME_BY_ID[descriptor.id],
  })),
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
