import { Settings } from '@texra-ai/harness/host';
import {
  GlobalStateKey,
  providerRegionSetting,
} from '@texra-ai/harness/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@texra/shared/model/codingPlans';
import type {
  ConfigWriteFailed,
  StateReadFailed,
  SettingsStores,
} from '@texra-ai/harness/host';
import type { Effect } from 'effect';

export interface CodingPlanSubscriptionRuntime {
  readonly descriptor: CodingPlanSubscription;
  readonly getEnabled: (
    stores: SettingsStores,
  ) => Effect.Effect<boolean, StateReadFailed>;
  /**
   * Persist the toggle through the shared config write path. An `Effect`, like
   * every other write of a catalog-backed setting, so the caller's program
   * composes it and owns the failure.
   */
  readonly setEnabled: (
    stores: SettingsStores,
    enabled: boolean,
  ) => Effect.Effect<void, ConfigWriteFailed | Error>;
}

const RUNTIME_BY_ID = {
  glmCodingPlan: {
    getEnabled: (stores) =>
      Settings.get<boolean>(stores, GlobalStateKey.GLM_CODING_PLAN),
    setEnabled: (stores, enabled) =>
      Settings.set(stores, GlobalStateKey.GLM_CODING_PLAN, enabled),
  },
  kimiCode: {
    getEnabled: (stores) =>
      Settings.get<boolean>(stores, GlobalStateKey.KIMI_CODE_PREFER),
    setEnabled: (stores, enabled) =>
      Settings.set(stores, GlobalStateKey.KIMI_CODE_PREFER, enabled),
  },
} as const satisfies Record<
  CodingPlanSubscription['id'],
  Omit<CodingPlanSubscriptionRuntime, 'descriptor'>
>;

/**
 * Runtime catalog consumed by retry policy and host route presentation. Which
 * plan serves a model's next request is not answered here: the picker decides
 * it (the `usageRoute` of each `readModelOptions` option).
 */
export const codingPlanSubscriptionRuntimes: readonly CodingPlanSubscriptionRuntime[] =
  Object.freeze(
    CODING_PLAN_SUBSCRIPTIONS.map((descriptor) =>
      Object.freeze({ descriptor, ...RUNTIME_BY_ID[descriptor.id] }),
    ),
  );

/**
 * The plan whose usage endpoint varies with the setting `key`: a plan's
 * usage is read on its provider's region, so its region toggle is that
 * setting (the GLM Coding Plan on `texra.glm.useChina`).
 */
export function codingPlanForUsageSetting(
  key: string,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_SUBSCRIPTIONS.find(
    (plan) => providerRegionSetting(plan.apiProvider)?.key === key,
  );
}
