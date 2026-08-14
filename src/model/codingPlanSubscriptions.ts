import { ModelProvider } from 'llm-zoo';

import { hasUsableApiKey } from '@model/apiProviders';
import { includedModelAccess } from '@model/includedModelAccess';
import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';
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
  const includedAccess = includedModelAccess();
  if (
    includedAccess.getUseIncludedModelAccess() &&
    (await includedAccess.canUseServerSideKeys())
  ) {
    return false;
  }
  return hasUsableApiKey(platform().secrets, 'glm');
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
