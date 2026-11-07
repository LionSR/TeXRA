import { Settings, type SettingsStores } from '@texra-ai/harness/plugins';
import {
  providerRegionSetting,
  GLM_CODING_PLAN_SETTING,
  KIMI_CODE_PREFER_SETTING,
} from '@texra-ai/harness/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@texra/shared/model/codingPlans';
import type {
  ConfigWriteFailed,
  StateReadFailed,
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
    getEnabled: (stores) => Settings.get(stores, GLM_CODING_PLAN_SETTING),
    setEnabled: (stores, enabled) =>
      Settings.set(stores, GLM_CODING_PLAN_SETTING, enabled),
  },
  kimiCode: {
    getEnabled: (stores) => Settings.get(stores, KIMI_CODE_PREFER_SETTING),
    setEnabled: (stores, enabled) =>
      Settings.set(stores, KIMI_CODE_PREFER_SETTING, enabled),
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
